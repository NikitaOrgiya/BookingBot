-- Этап 3, корректирующий аудит. Crash-safe lease-модель claim/complete/
-- release для идемпотентности Telegram webhook.
--
-- Эта миграция ЕЩЁ НЕ применялась к облачной базе (см. README/аудит) и
-- полностью заменяет собой предыдущее содержимое одноимённого файла —
-- модель claim/release на DELETE, которая создавала, а не решала, проблему:
-- DELETE выполнялся только в JS try/catch и НИКОГДА не выполнялся, если
-- процесс был убит снаружи (SIGKILL, serverless timeout, деплой/OOM) между
-- claim и завершением обработки. В этом случае update_id оставался
-- "заявленным" навсегда, и Telegram, повторно доставляя update, тихо не
-- получал никакой обработки.
--
-- Новая модель — claim с lease (TTL) вместо claim/DELETE:
--
--   processed_telegram_updates.status:
--     'processing' — update прямо сейчас (либо ещё) заявлен и обрабатывается;
--     'completed'  — обработка завершена успешно, повторно НИКОГДА не
--                    выполняется (запись никогда не удаляется и не
--                    возвращается в 'processing' автоматически).
--
--   locked_until — момент, после которого lease текущего claim_token
--   считается истёкшим и его можно перезахватить (claim с новым
--   claim_token). Значение НАМЕРЕННО выбрано много больше нормального
--   времени обработки одного update (см. LEASE_SECONDS в
--   lib/telegram/idempotency.ts, по умолчанию 120 секунд): нормальная
--   обработка update ботом (upsert профиля, чтение/запись booking_session,
--   один RPC ядра бронирования, один вызов Telegram Bot API на ответ)
--   занимает низкие сотни миллисекунд — единицы секунд, 120 секунд
--   оставляют огромный запас на медленную сеть/БД, не давая при этом
--   зависшему без возврата воркеру блокировать retry на неопределённый срок.
--
--   claim_token — одноразовый токен текущего владения claim. complete/
--   release обязаны предъявить ТОЧНО тот claim_token, который вернул
--   claim_telegram_update — иначе "старый" воркер, доживший своё
--   выполнение уже ПОСЛЕ истечения его lease и перезахвата другим
--   воркером, не может ни завершить (complete), ни освободить (release)
--   чужой (новый) claim. Без этого была бы возможна классическая гонка
--   "zombie writer": воркер A завис на 130 секунд, воркер B перезахватил
--   и успешно завершил update, а затем "ожившая" попытка A вызвала бы
--   complete/release и стёрла бы результат работы B.
--
--   attempt_count — счётчик попыток (первичный claim = 1, каждый re-claim
--   после истёкшего lease увеличивает счётчик) — только для диагностики,
--   бизнес-логика на него не полагается.
--
--   last_error_code — безопасный (без персональных данных и без сырого
--   текста ошибки PostgreSQL/Telegram) код последней неудачной попытки,
--   для диагностики. Заполняется только release_telegram_update.
--
-- DELETE больше не используется вообще: ни как основной механизм (успешно
-- обработанные update по-прежнему никогда не освобождаются), ни как путь
-- отката при ошибке (release_telegram_update просто снимает lease, а не
-- удаляет строку) — поэтому service_role лишается DELETE и получает UPDATE
-- вместо него.

-- =====================================================================
-- 1. Схема: новые колонки lease-модели.
-- =====================================================================

alter table public.processed_telegram_updates
  add column if not exists status text not null default 'processing',
  add column if not exists claim_token uuid not null default gen_random_uuid(),
  add column if not exists claimed_at timestamptz not null default now(),
  add column if not exists locked_until timestamptz not null default now(),
  add column if not exists completed_at timestamptz,
  add column if not exists attempt_count integer not null default 1,
  add column if not exists updated_at timestamptz not null default now(),
  add column if not exists last_error_code text;

-- Существующие строки (созданные ДО этой миграции старой моделью
-- claim/release-DELETE) по определению означали "update уже успешно
-- обработан" — единственный способ строке пережить старую модель было
-- либо успешное завершение (никогда не освобождалось), либо она была бы
-- удалена при ошибке и не существовала бы вовсе. Поэтому предсказуемая и
-- безопасная миграция данных — перевести все такие строки в 'completed',
-- а не оставлять их 'processing' (что сделало бы их немедленно
-- перезахватываемыми и потенциально повторно исполнило бы уже
-- отработанные update).
update public.processed_telegram_updates
   set status = 'completed',
       completed_at = coalesce(completed_at, claimed_at, now()),
       locked_until = coalesce(completed_at, claimed_at, now())
 where status = 'processing';

alter table public.processed_telegram_updates
  add constraint processed_telegram_updates_status_check
    check (status in ('processing', 'completed'));

alter table public.processed_telegram_updates
  add constraint processed_telegram_updates_completed_at_check
    check (
      (status = 'completed' and completed_at is not null)
      or (status = 'processing' and completed_at is null)
    );

create trigger set_updated_at
  before update on public.processed_telegram_updates
  for each row execute function public.set_updated_at();

-- Ускоряет потенциальную будущую фоновую диагностику зависших
-- processing-строк (locked_until в прошлом).
create index if not exists processed_telegram_updates_status_locked_until_idx
  on public.processed_telegram_updates (status, locked_until)
  where status = 'processing';

-- =====================================================================
-- 2. claim_telegram_update — атомарный захват (или перезахват) update_id.
-- =====================================================================
--
-- Возвращает ровно одну строку:
--   result = 'claimed'   — новый update ИЛИ ранее просроченный (locked_until
--                          в прошлом) processing-claim перезахвачен; caller
--                          обязан выполнить бизнес-действие и затем вызвать
--                          complete_telegram_update(..., claim_token) или,
--                          при обычной ошибке, release_telegram_update(...).
--                          claim_token — новый, уникальный для ЭТОЙ попытки.
--   result = 'completed' — update уже был успешно обработан ранее; caller
--                          обязан пропустить бизнес-действие и ответить
--                          Telegram успехом (2xx).
--   result = 'busy'      — другой воркер владеет ещё действующим (не
--                          истёкшим) lease прямо сейчас; caller НЕ должен
--                          возвращать Telegram успешный ответ (иначе
--                          Telegram прекратит повторную доставку до того,
--                          как реальная обработка завершится) — нужен
--                          retryable статус (503), см.
--                          lib/telegram/webhook-handler.ts.
--   claim_token IS NULL, если result <> 'claimed'.
--
-- Атомарность: INSERT ... ON CONFLICT DO NOTHING гарантирует, что при
-- буквально одновременной первой попытке ровно один вызов реально создаёт
-- строку (FOUND = true); все остальные параллельные вызовы получают
-- FOUND = false и переходят к SELECT ... FOR UPDATE, который блокируется
-- на row-level лок до commit "победившей" транзакции, после чего видит уже
-- зафиксированное состояние (свежий, ещё не истёкший lease) и корректно
-- возвращают 'busy', а не ложный повторный 'claimed'.

create or replace function public.claim_telegram_update(
  p_telegram_update_id bigint,
  p_lease_seconds integer default 120
)
returns table(result text, claim_token uuid)
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_now timestamptz := now();
  v_new_token uuid := gen_random_uuid();
  v_row public.processed_telegram_updates;
begin
  if p_lease_seconds is null or p_lease_seconds <= 0 then
    raise exception using errcode = 'PB014', message = 'INVALID_LEASE_SECONDS';
  end if;

  insert into public.processed_telegram_updates (
    telegram_update_id, status, claim_token, claimed_at, locked_until, attempt_count
  ) values (
    p_telegram_update_id, 'processing', v_new_token, v_now,
    v_now + make_interval(secs => p_lease_seconds), 1
  )
  on conflict (telegram_update_id) do nothing;

  if found then
    return query select 'claimed'::text, v_new_token;
    return;
  end if;

  -- Строка уже существовала: блокируем её на время проверки, чтобы
  -- конкурирующие вызовы (в т.ч. другой перезахват просроченного lease)
  -- сериализовались, а не гонялись за одним и тем же "просроченным" окном.
  select *
    into v_row
    from public.processed_telegram_updates
   where telegram_update_id = p_telegram_update_id
     for update;

  if v_row.status = 'completed' then
    return query select 'completed'::text, null::uuid;
    return;
  end if;

  -- status = 'processing'.
  if v_row.locked_until > v_now then
    return query select 'busy'::text, null::uuid;
    return;
  end if;

  -- Lease истёк: перезахват с НОВЫМ claim_token. Старый claim_token
  -- (у зависшего/убитого воркера) больше нигде не совпадёт со свежим
  -- значением в строке — ни complete, ни release им не пройдут (см. ниже).
  update public.processed_telegram_updates
     set claim_token = v_new_token,
         claimed_at = v_now,
         locked_until = v_now + make_interval(secs => p_lease_seconds),
         attempt_count = v_row.attempt_count + 1
   where telegram_update_id = p_telegram_update_id;

  return query select 'claimed'::text, v_new_token;
end;
$$;

-- =====================================================================
-- 3. complete_telegram_update — фиксирует успешное завершение обработки.
-- =====================================================================
--
-- Переводит update в 'completed' ТОЛЬКО если claim_token совпадает с тем,
-- что сейчас реально владеет claim'ом (и статус всё ещё 'processing') —
-- это и есть защита от "ожившего" старого воркера: если его lease истёк и
-- update был перезахвачен другим воркером (claim_token сменился), UPDATE
-- не найдёт подходящую строку (0 строк обновлено) и функция вернёт false.
-- Caller обязан трактовать false как "не доверяй этому факту завершения
-- на уровне идемпотентности" (см. lib/telegram/idempotency.ts) — но саму
-- бизнес-операцию отменить всё равно нельзя, поэтому это только сигнал
-- для диагностики/логирования, не повод повторять действие.
--
-- Успешно завершённая строка НИКОГДА не удаляется и не перезахватывается:
-- claim_telegram_update для status='completed' всегда вернёт 'completed'.

create or replace function public.complete_telegram_update(
  p_telegram_update_id bigint,
  p_claim_token uuid
)
returns boolean
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_matched integer;
begin
  update public.processed_telegram_updates
     set status = 'completed',
         completed_at = now(),
         last_error_code = null
   where telegram_update_id = p_telegram_update_id
     and status = 'processing'
     and claim_token = p_claim_token;

  get diagnostics v_matched = row_count;
  return v_matched = 1;
end;
$$;

-- =====================================================================
-- 4. release_telegram_update — освобождает lease после обычной ошибки.
-- =====================================================================
--
-- НЕ удаляет строку (в отличие от прежней DELETE-модели) и НЕ переводит в
-- 'completed' — просто немедленно "просрочивает" locked_until (=now()),
-- позволяя следующей доставке того же update_id снова заявить update через
-- claim_telegram_update. status остаётся 'processing' — эта строка
-- принципиально ничем не отличается от "ещё не завершённого" claim'а,
-- кроме того, что её можно перезахватить прямо сейчас, а не только после
-- полного истечения исходного lease.
--
-- Как и complete, защищена claim_token: "ожившая" после истечения lease
-- попытка старого воркера не может освободить (а тем более испортить)
-- claim, уже перезахваченный кем-то другим.

create or replace function public.release_telegram_update(
  p_telegram_update_id bigint,
  p_claim_token uuid,
  p_error_code text default null
)
returns boolean
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_matched integer;
  v_now timestamptz := now();
begin
  update public.processed_telegram_updates
     set locked_until = v_now,
         last_error_code = left(p_error_code, 64)
   where telegram_update_id = p_telegram_update_id
     and status = 'processing'
     and claim_token = p_claim_token;

  get diagnostics v_matched = row_count;
  return v_matched = 1;
end;
$$;

-- =====================================================================
-- 5. Права.
-- =====================================================================
--
-- Табличные права: SELECT + INSERT + UPDATE. DELETE больше не нужен нигде
-- в новой модели (ни на claim, ни на complete, ни на release) и явно
-- отзывается.

revoke all on table public.processed_telegram_updates from service_role;

grant select, insert, update on table public.processed_telegram_updates
  to service_role;

revoke all on function
  public.claim_telegram_update(bigint, integer),
  public.complete_telegram_update(bigint, uuid),
  public.release_telegram_update(bigint, uuid, text)
from public, anon, authenticated;

grant execute on function
  public.claim_telegram_update(bigint, integer),
  public.complete_telegram_update(bigint, uuid),
  public.release_telegram_update(bigint, uuid, text)
to service_role;

-- =====================================================================
-- 6. Самопроверка (privilege audit), по образцу
--    20260716130200_booking_functions_privilege_audit.sql: миграция
--    обязана упасть, если реальные привилегии разошлись с моделью выше.
-- =====================================================================

do $$
declare
  leaked record;
  missing text;
  fn text;
  fns text[] := array[
    'public.claim_telegram_update(bigint, integer)',
    'public.complete_telegram_update(bigint, uuid)',
    'public.release_telegram_update(bigint, uuid, text)'
  ];
begin
  -- 6a. Табличные права processed_telegram_updates: anon/authenticated —
  -- ничего; service_role — ровно SELECT+INSERT+UPDATE, без DELETE.
  for leaked in
    select table_name, privilege_type, grantee
    from information_schema.role_table_grants
    where table_schema = 'public'
      and table_name = 'processed_telegram_updates'
      and grantee in ('anon', 'authenticated', 'PUBLIC')
  loop
    raise exception
      'Аудит GRANT провален: % имеет % на public.processed_telegram_updates',
      leaked.grantee, leaked.privilege_type;
  end loop;

  foreach missing in array array['SELECT', 'INSERT', 'UPDATE']
  loop
    if not exists (
      select 1
      from information_schema.role_table_grants
      where table_schema = 'public'
        and table_name = 'processed_telegram_updates'
        and grantee = 'service_role'
        and privilege_type = missing
    ) then
      raise exception
        'Аудит GRANT провален: service_role не имеет % на public.processed_telegram_updates',
        missing;
    end if;
  end loop;

  if exists (
    select 1
    from information_schema.role_table_grants
    where table_schema = 'public'
      and table_name = 'processed_telegram_updates'
      and grantee = 'service_role'
      and privilege_type = 'DELETE'
  ) then
    raise exception
      'Аудит GRANT провален: service_role имеет лишний DELETE на public.processed_telegram_updates (lease-модель claim/complete/release использует только SELECT/INSERT/UPDATE)';
  end if;

  -- 6b. Функции: ни PUBLIC/anon/authenticated не выполняют, только
  -- service_role; не SECURITY DEFINER; фиксированный search_path.
  foreach fn in array fns loop
    if has_function_privilege('public', fn, 'EXECUTE') then
      raise exception 'Аудит функций провален: % выполнима ролью PUBLIC', fn;
    end if;
    if has_function_privilege('anon', fn, 'EXECUTE') then
      raise exception 'Аудит функций провален: % выполнима ролью anon', fn;
    end if;
    if has_function_privilege('authenticated', fn, 'EXECUTE') then
      raise exception 'Аудит функций провален: % выполнима ролью authenticated', fn;
    end if;
    if not has_function_privilege('service_role', fn, 'EXECUTE') then
      raise exception 'Аудит функций провален: service_role НЕ может выполнить % (нужен GRANT EXECUTE)', fn;
    end if;
    if (select p.prosecdef from pg_proc p where p.oid = fn::regprocedure) then
      raise exception 'Аудит функций провален: % объявлена SECURITY DEFINER без необходимости (service_role уже имеет BYPASSRLS и все нужные GRANT)', fn;
    end if;
    if not (
      (select p.proconfig from pg_proc p where p.oid = fn::regprocedure)
        @> array['search_path=public, pg_temp']
    ) then
      raise exception 'Аудит функций провален: у % не зафиксирован search_path=public, pg_temp', fn;
    end if;
  end loop;
end;
$$;
