-- Этап 4. До этой миграции public.appointments.sql выдавала authenticated
-- (администратор) широкий UPDATE на всю таблицу appointments. Это позволило
-- бы панели администратора (случайно или намеренно) изменить время,
-- клиента, услугу или snapshot-поля записи в обход бизнес-правил — хотя
-- разрешено менять только статус. Эта миграция сужает доступ до одной
-- безопасной функции.
--
-- Доменные коды ошибок (тот же принцип, что и в booking_functions.sql —
-- класс 'PB', стабильный текст MESSAGE):
--   PB009 APPOINTMENT_NOT_FOUND (переиспользуется из Этапа 2 — то же значение)
--   PB014 INVALID_STATUS_TRANSITION
-- "Не администратор" сигнализируется стандартным 42501 (insufficient_privilege)
-- с текстом NOT_ADMIN — это вопрос привилегии, а не бизнес-правила.

create or replace function public.admin_change_appointment_status(
  p_appointment_id uuid,
  p_new_status text,
  p_reason text default null
)
returns public.appointments
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_appt public.appointments;
  v_now timestamptz := now();
begin
  if not public.is_admin() then
    raise exception using errcode = '42501', message = 'NOT_ADMIN';
  end if;

  if p_new_status not in ('completed', 'cancelled', 'no_show') then
    raise exception using errcode = 'PB014', message = 'INVALID_STATUS_TRANSITION';
  end if;

  -- Блокируем строку на время проверки перехода — конкурентные изменения
  -- статуса одной и той же записи не должны гоняться между собой.
  select *
    into v_appt
    from public.appointments as a
   where a.id = p_appointment_id
   for update;

  if not found then
    raise exception using errcode = 'PB009', message = 'APPOINTMENT_NOT_FOUND';
  end if;

  -- Единственные разрешённые переходы: confirmed -> {completed, cancelled,
  -- no_show}. Любой другой исходный статус (в том числе повторный переход
  -- из уже completed/cancelled/no_show) отклоняется — обратных переходов
  -- нет.
  if v_appt.status <> 'confirmed' then
    raise exception using errcode = 'PB014', message = 'INVALID_STATUS_TRANSITION';
  end if;

  if p_new_status = 'cancelled' then
    update public.appointments as a
       set status = 'cancelled',
           cancelled_at = v_now,
           cancel_reason = p_reason
     where a.id = p_appointment_id
    returning * into v_appt;
  else
    -- completed / no_show: cancelled_at/cancel_reason не трогаем — запись
    -- не была отменена.
    update public.appointments as a
       set status = p_new_status
     where a.id = p_appointment_id
    returning * into v_appt;
  end if;

  return v_appt;
end;
$$;

revoke all on function public.admin_change_appointment_status(uuid, text, text)
  from public, anon;
grant execute on function public.admin_change_appointment_status(uuid, text, text)
  to authenticated;

-- SECURITY DEFINER выполняется от имени владельца функции (как и
-- is_admin()) и обходит RLS/GRANT самостоятельно — authenticated больше не
-- нуждается в табличном UPDATE на appointments, единственный путь изменить
-- статус теперь — эта функция.
revoke update on table public.appointments from authenticated;

-- Политика appointments_admin_update опиралась именно на этот GRANT UPDATE;
-- без него она структурно бесполезна (UPDATE от authenticated в принципе
-- невозможен) — удаляем явно, чтобы не оставлять вводящий в заблуждение
-- артефакт схемы.
drop policy if exists appointments_admin_update on public.appointments;
