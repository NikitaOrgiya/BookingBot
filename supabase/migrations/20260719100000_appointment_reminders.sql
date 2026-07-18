-- Этап 5. Автоматические Telegram-напоминания о записи.
--
-- Аудит перед этой миграцией обнаружил `public.notification_deliveries`
-- (миграция 20260716101100_notification_deliveries.sql, Этап 1) — таблицу
-- почти с тем же назначением (appointment_id, notification_type
-- 'reminder_first'/'reminder_second', unique(appointment_id,
-- notification_type), RLS+GRANT уже готовы: authenticated — SELECT +
-- is_admin()-политика, service_role — SELECT/INSERT/UPDATE), которую до
-- этой миграции не использовал ни один RPC и ни одна строка TypeScript
-- (единственные упоминания в истории до Этапа 5 — её же CREATE TABLE,
-- аудит привилегий Этапа 4 (20260718110000_service_role_least_privilege.sql)
-- и pgTAP-проверки GRANT/RLS в supabase/tests/permissions.test.sql).
--
-- Первая версия этой миграции ЭВОЛЮЦИОНИРОВАЛА notification_deliveries
-- через ALTER TABLE ... RENAME вместо создания новой таблицы, чтобы не
-- заводить дублирующую инфраструктуру. Повторный, более строгий аудит
-- показал, что этого недостаточно для production-безопасности: README
-- этого же репозитория (раздел "Этап 4", "Результаты проверки")
-- утверждает, что миграции Этапа 4 "применены к удалённой (remote)
-- Supabase-базе и совпадают с локальными" — а миграции применяются
-- строго последовательно, значит и миграция Этапа 1, создавшая
-- notification_deliveries, с высокой вероятностью уже применена на
-- реальном remote/production проекте. Ни этот, ни какой-либо предыдущий
-- агент/сессия не имеет доступа к учётным данным этого production-проекта
-- (`supabase migration list`/`db push --dry-run` в этой песочнице падают
-- с "Cannot find project ref" — проект не слинкован), поэтому ни
-- "таблица никогда не применялась к production", ни "remote migration
-- history её не содержит" не могут быть здесь доказаны — а именно это
-- требуется, чтобы прямое переименование production-объекта было
-- допустимо. Поэтому от переименования отказались.
--
-- Вместо этого: notification_deliveries НЕ переименовывается, НЕ
-- изменяется и вообще не упоминается ни в одном DDL-операторе этой
-- миграции — она остаётся ровно такой, какая есть (дальше в этом файле
-- нет ни одной ссылки на неё). Функционал Этапа 5 живёт в НОВОЙ,
-- отдельной таблице `public.appointment_reminders`, создаваемой с нуля
-- ниже. Это additive, backward-compatible изменение: что бы ни находилось
-- (или не находилось) в notification_deliveries на реальном
-- production-проекте прямо сейчас, эта миграция этого не касается и не
-- может сломать. Дальнейшая судьба notification_deliveries (оставить
-- как есть навсегда / удалить отдельной миграцией после явного
-- подтверждения владельца, что на production-проекте её точно нет или её
-- содержимое не нужно) — вне рамок Этапа 5.

create table public.appointment_reminders (
  id uuid primary key default gen_random_uuid(),
  appointment_id uuid not null
    references public.appointments (id) on delete cascade,
  reminder_type text not null,
  status text not null default 'pending',
  attempt_count integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  locked_at timestamptz,
  scheduled_for timestamptz not null,
  sent_at timestamptz,
  telegram_message_id bigint,
  last_error_code text,
  last_error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint appointment_reminders_type_allowed
    check (reminder_type in ('24h', '2h')),
  constraint appointment_reminders_status_allowed
    check (status in ('pending', 'processing', 'sent', 'failed', 'skipped')),
  constraint appointment_reminders_attempt_count_non_negative
    check (attempt_count >= 0),
  constraint appointment_reminders_unique_type
    unique (appointment_id, reminder_type),
  -- sent_at заполнен тогда и только тогда, когда status = 'sent' — нельзя
  -- ни "успешно отправить" без метки времени, ни проставить sent_at для
  -- строки в любом другом статусе.
  constraint appointment_reminders_sent_at_consistency
    check ((status = 'sent') = (sent_at is not null)),
  -- last_error_message обрезается на уровне приложения (lib/reminders/retry.ts)
  -- до отправки в RPC — это ограничение дополнительный, а не единственный
  -- барьер против случайно длинного текста ошибки в БД.
  constraint appointment_reminders_last_error_message_length
    check (last_error_message is null or char_length(last_error_message) <= 500)
);

create index appointment_reminders_scheduled_for_idx
  on public.appointment_reminders (scheduled_for);
create index appointment_reminders_status_idx
  on public.appointment_reminders (status);
create index appointment_reminders_next_attempt_at_idx
  on public.appointment_reminders (next_attempt_at);
create index appointment_reminders_appointment_id_idx
  on public.appointment_reminders (appointment_id);
-- Поиск due-напоминаний для claim_due_appointment_reminders: строго
-- pending/processing, отсортированные по времени назначения.
create index appointment_reminders_due_idx
  on public.appointment_reminders (status, next_attempt_at)
  where status in ('pending', 'processing');

create trigger set_updated_at
  before update on public.appointment_reminders
  for each row execute function public.set_updated_at();

alter table public.appointment_reminders enable row level security;
alter table public.appointment_reminders force row level security;

revoke all on table public.appointment_reminders from anon, authenticated;

-- Те же привилегии, что и у notification_deliveries (Этап 1): администратор
-- только просматривает журнал напоминаний, cron-обработчик (service_role)
-- пишет и обновляет статусы попыток отправки.
grant select on table public.appointment_reminders to authenticated;
grant select, insert, update on table public.appointment_reminders to service_role;

create policy appointment_reminders_admin_select
  on public.appointment_reminders
  for select
  to authenticated
  using (public.is_admin());

-- =====================================================================
-- Триггер создания/аннулирования строк-напоминаний.
-- =====================================================================
--
-- Использует уже существующие (с Этапа 1) business_settings.reminder_first_minutes
-- / reminder_second_minutes ("за сколько минут до записи присылать
-- напоминание"; NULL = этот тип отключён администратором) — те же
-- значения уже редактируются на /admin/settings (Этап 4,
-- components/admin/settings-form.tsx), отдельной настройки под Этап 5 не
-- заводится.
--
-- AFTER INSERT: если новая запись сразу 'confirmed', создаёт до двух
-- строк-напоминаний (24h/2h) — но только те, для которых:
--   1) соответствующий *_minutes в business_settings не NULL;
--   2) вычисленный scheduled_for ещё в будущем строго относительно
--      момента создания записи. Единое условие одновременно реализует
--      оба требования технического задания: "не создавать просроченные
--      напоминания" и "не слать 24ч/2ч-напоминание для записи, созданной
--      менее чем за 24ч/2ч до начала" — момент "N минут до начала" уже
--      прошёл (или наступает раньше, чем успевает быть создана сама
--      строка), и напоминание просто не заводится.
--
-- AFTER UPDATE OF status: если статус меняется на terminal
-- (cancelled/completed/no_show) с 'confirmed', ещё не отправленные
-- (status = 'pending') напоминания этой записи переводятся в 'skipped' —
-- атомарно, в той же транзакции, что и сама смена статуса записи.
-- Строки в 'processing' здесь не трогаются: воркер обязан сам
-- перепроверить статус записи прямо перед отправкой (см.
-- lib/reminders/worker.ts) и обработает эту гонку через
-- mark_appointment_reminder_skipped.

create or replace function public.create_appointment_reminders_for_confirmed()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_first_minutes integer;
  v_second_minutes integer;
  v_now timestamptz := now();
  v_scheduled timestamptz;
begin
  if new.status <> 'confirmed' then
    return new;
  end if;
  if tg_op = 'UPDATE' and old.status = 'confirmed' then
    return new;
  end if;

  select bs.reminder_first_minutes, bs.reminder_second_minutes
    into v_first_minutes, v_second_minutes
    from public.business_settings as bs
   where bs.id = 1;

  -- next_attempt_at ЯВНО выставляется равным scheduled_for — если
  -- положиться на column default (now()), новая строка стала бы
  -- claim_due_appointment_reminders'у "due" сразу же при создании,
  -- независимо от того, насколько далеко в будущем реальный
  -- scheduled_for (next_attempt_at, а не scheduled_for — то, что
  -- реально проверяет claim у pending-строк).

  if v_first_minutes is not null then
    v_scheduled := new.start_at - make_interval(mins => v_first_minutes);
    if v_scheduled > v_now then
      insert into public.appointment_reminders
        (appointment_id, reminder_type, scheduled_for, next_attempt_at)
      values (new.id, '24h', v_scheduled, v_scheduled)
      on conflict (appointment_id, reminder_type) do nothing;
    end if;
  end if;

  if v_second_minutes is not null then
    v_scheduled := new.start_at - make_interval(mins => v_second_minutes);
    if v_scheduled > v_now then
      insert into public.appointment_reminders
        (appointment_id, reminder_type, scheduled_for, next_attempt_at)
      values (new.id, '2h', v_scheduled, v_scheduled)
      on conflict (appointment_id, reminder_type) do nothing;
    end if;
  end if;

  return new;
end;
$$;

create trigger create_appointment_reminders_after_insert
  after insert on public.appointments
  for each row execute function public.create_appointment_reminders_for_confirmed();

create trigger create_appointment_reminders_after_confirm
  after update of status on public.appointments
  for each row execute function public.create_appointment_reminders_for_confirmed();

create or replace function public.skip_appointment_reminders_on_terminal_status()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if old.status = 'confirmed' and new.status in ('cancelled', 'completed', 'no_show') then
    update public.appointment_reminders
       set status = 'skipped'
     where appointment_id = new.id
       and status = 'pending';
  end if;
  return new;
end;
$$;

create trigger skip_appointment_reminders_after_terminal_status
  after update of status on public.appointments
  for each row execute function public.skip_appointment_reminders_on_terminal_status();

-- =====================================================================
-- Backfill: уже существующие подтверждённые будущие записи, созданные до
-- этой миграции, не проходили через триггер выше и без этого шага никогда
-- не получили бы напоминаний. Тот же принцип "не создавать просроченные
-- напоминания" (scheduled_for > now()) применяется и здесь. Идемпотентно
-- (WHERE NOT EXISTS + ON CONFLICT DO NOTHING) и безопасно для повторного
-- запуска — тот же самый запрос можно выполнить вручную позже, если
-- администратор включит ранее отключённый (NULL) тип напоминания и
-- захочет забрать в него уже существующие будущие записи (см. README —
-- "Этап 5" -> "Backfill вручную").
-- next_attempt_at выставляется равным вычисленному scheduled_for — тем же
-- образом и по той же причине, что и в триггере выше.
insert into public.appointment_reminders (appointment_id, reminder_type, scheduled_for, next_attempt_at)
select
  a.id, '24h',
  a.start_at - make_interval(mins => bs.reminder_first_minutes),
  a.start_at - make_interval(mins => bs.reminder_first_minutes)
from public.appointments as a
cross join public.business_settings as bs
where bs.id = 1
  and a.status = 'confirmed'
  and a.start_at > now()
  and bs.reminder_first_minutes is not null
  and a.start_at - make_interval(mins => bs.reminder_first_minutes) > now()
  and not exists (
    select 1 from public.appointment_reminders as ar
    where ar.appointment_id = a.id and ar.reminder_type = '24h'
  )
on conflict (appointment_id, reminder_type) do nothing;

insert into public.appointment_reminders (appointment_id, reminder_type, scheduled_for, next_attempt_at)
select
  a.id, '2h',
  a.start_at - make_interval(mins => bs.reminder_second_minutes),
  a.start_at - make_interval(mins => bs.reminder_second_minutes)
from public.appointments as a
cross join public.business_settings as bs
where bs.id = 1
  and a.status = 'confirmed'
  and a.start_at > now()
  and bs.reminder_second_minutes is not null
  and a.start_at - make_interval(mins => bs.reminder_second_minutes) > now()
  and not exists (
    select 1 from public.appointment_reminders as ar
    where ar.appointment_id = a.id and ar.reminder_type = '2h'
  )
on conflict (appointment_id, reminder_type) do nothing;
