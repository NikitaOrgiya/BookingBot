-- Этап 5. Атомарный claim и учёт результата доставки напоминаний.
--
-- Все четыре функции ниже вызываются ИСКЛЮЧИТЕЛЬНО из GET
-- /api/cron/reminders (lib/reminders/worker.ts) под service_role — тем же
-- принципом, что и ядро бронирования (booking_functions.sql):
-- SECURITY INVOKER (не DEFINER), т.к. единственный вызывающий уже обходит
-- RLS (bypassrls) и получает ниже ровно те табличные права, которые ему
-- нужны — поднимать привилегии через DEFINER незачем. Фиксированный
-- search_path — по той же причине, что и везде в проекте: вызывающая роль
-- не должна суметь подменить объекты через свой search_path.
--
-- "Валидный Telegram chat_id" отдельно не проверяется: chat_id для
-- личного чата — это appointments.telegram_user_id ->
-- telegram_users.telegram_user_id (bigint not null, unique) — записи без
-- него структурно невозможны, а не просто маловероятны.
--
-- Округление ретраев (сколько попыток, какая задержка) сознательно НЕ
-- реализовано в SQL: claim_due_appointment_reminders только увеличивает
-- attempt_count и возвращает его воркеру, а решение "это финальная
-- неудача или ещё один retry с какой задержкой" принимает
-- lib/reminders/retry.ts (TypeScript, юнит-тестируемый без БД) и передаёт
-- готовый результат в mark_appointment_reminder_failed. SQL здесь отвечает
-- только за атомарность состояния, не за бизнес-политику ретраев.

create or replace function public.claim_due_appointment_reminders(
  p_batch_size integer default 20
)
returns table (
  reminder_id uuid,
  appointment_id uuid,
  reminder_type text,
  attempt_count integer,
  chat_id bigint,
  service_name text,
  start_at timestamptz,
  business_name text,
  timezone text
)
language plpgsql
set search_path = public, pg_temp
as $$
declare
  -- Границы batch — оборонительное ограничение против случайного
  -- p_batch_size <= 0 или неоправданно большого значения; вызывающая
  -- сторона доверенная (service_role, свой собственный cron route), но
  -- жёсткий верхний предел всё равно не даёт одному вызову захватить
  -- неограниченно много строк.
  v_batch_size integer := greatest(1, least(coalesce(p_batch_size, 20), 100));
  v_now timestamptz := now();
  -- Lease processing-строки: захваченная, но не подтверждённая (ни sent,
  -- ни failed, ни skipped) строка старше этого порога считается
  -- зависшей (воркер убит/оборвался после claim, до mark_*) и может быть
  -- перезахвачена — тот же принцип, что и locked_until в
  -- processed_telegram_updates (Этап 3), с большим запасом относительно
  -- реального времени одного вызова Telegram Bot API.
  v_lease_minutes constant integer := 10;
begin
  return query
  with due as (
    select ar.id
      from public.appointment_reminders as ar
      join public.appointments as a on a.id = ar.appointment_id
     where a.status = 'confirmed'
       and a.start_at > v_now
       and (
         (ar.status = 'pending' and ar.next_attempt_at <= v_now)
         or (
           ar.status = 'processing'
           and ar.locked_at < v_now - make_interval(mins => v_lease_minutes)
         )
       )
     order by ar.scheduled_for
     limit v_batch_size
     for update of ar skip locked
  ),
  claimed as (
    update public.appointment_reminders as ar
       set status = 'processing',
           locked_at = v_now,
           attempt_count = ar.attempt_count + 1
      from due
     where ar.id = due.id
    returning ar.id, ar.appointment_id, ar.reminder_type, ar.attempt_count
  )
  select
    c.id,
    c.appointment_id,
    c.reminder_type,
    c.attempt_count,
    tu.telegram_user_id,
    a.service_name_snapshot,
    a.start_at,
    bs.business_name,
    bs.timezone
    from claimed as c
    join public.appointments as a on a.id = c.appointment_id
    join public.telegram_users as tu on tu.id = a.telegram_user_id
    cross join public.business_settings as bs
   where bs.id = 1;
end;
$$;

-- Перед фактической отправкой worker обязан ещё раз проверить актуальный
-- статус appointment (см. lib/reminders/worker.ts) — claim гарантирует
-- эксклюзивный захват СТРОКИ НАПОМИНАНИЯ, а не заморозку appointment: она
-- могла быть отменена администратором или клиентом уже ПОСЛЕ claim, но
-- ДО реальной отправки. Для этого случая — mark_appointment_reminder_skipped.

create or replace function public.mark_appointment_reminder_sent(
  p_reminder_id uuid,
  p_telegram_message_id bigint default null
)
returns boolean
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_matched integer;
begin
  update public.appointment_reminders
     set status = 'sent',
         sent_at = now(),
         telegram_message_id = p_telegram_message_id,
         last_error_code = null,
         last_error_message = null
   where id = p_reminder_id
     and status = 'processing';

  get diagnostics v_matched = row_count;
  return v_matched > 0;
end;
$$;

-- p_next_attempt_at/p_terminal вычислены в TypeScript (lib/reminders/retry.ts)
-- по attempt_count, вернувшемуся из claim, и по классификации ошибки
-- Telegram (retry_after у 429, постоянные 4xx и т.д.) — см. комментарий в
-- начале файла. last_error_message обрезается здесь ещё раз (defense in
-- depth) сверх CHECK-ограничения таблицы и сверх обрезки в TypeScript.
create or replace function public.mark_appointment_reminder_failed(
  p_reminder_id uuid,
  p_error_code text,
  p_error_message text,
  p_next_attempt_at timestamptz default null,
  p_terminal boolean default false
)
returns boolean
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_matched integer;
begin
  update public.appointment_reminders
     set status = case when p_terminal then 'failed' else 'pending' end,
         next_attempt_at =
           case when p_terminal then next_attempt_at
                else coalesce(p_next_attempt_at, now())
           end,
         last_error_code = p_error_code,
         last_error_message = left(p_error_message, 500)
   where id = p_reminder_id
     and status = 'processing';

  get diagnostics v_matched = row_count;
  return v_matched > 0;
end;
$$;

-- Используется, когда worker обнаруживает при пред-отправочной проверке,
-- что claim'нутое напоминание больше не должно быть отправлено (запись
-- отменена/завершена/уже началась между claim и отправкой) — редкая гонка,
-- не ошибка Telegram API.
create or replace function public.mark_appointment_reminder_skipped(
  p_reminder_id uuid,
  p_reason text default null
)
returns boolean
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_matched integer;
begin
  update public.appointment_reminders
     set status = 'skipped',
         last_error_code = case when p_reason is not null then 'SKIPPED' else last_error_code end,
         last_error_message = coalesce(left(p_reason, 500), last_error_message)
   where id = p_reminder_id
     and status = 'processing';

  get diagnostics v_matched = row_count;
  return v_matched > 0;
end;
$$;

revoke all on function
  public.claim_due_appointment_reminders(integer),
  public.mark_appointment_reminder_sent(uuid, bigint),
  public.mark_appointment_reminder_failed(uuid, text, text, timestamptz, boolean),
  public.mark_appointment_reminder_skipped(uuid, text)
from public, anon, authenticated;

grant execute on function
  public.claim_due_appointment_reminders(integer),
  public.mark_appointment_reminder_sent(uuid, bigint),
  public.mark_appointment_reminder_failed(uuid, text, text, timestamptz, boolean),
  public.mark_appointment_reminder_skipped(uuid, text)
to service_role;
