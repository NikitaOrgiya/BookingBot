-- Этап 4. Разовые блокировки расписания вводятся администратором как
-- локальные дата+время (например, "20 июля, 14:00-16:00"). Интерпретировать
-- их через timezone браузера клиента или сервера Vercel — верный способ
-- получить блокировку "не в то время" при малейшем расхождении часовых
-- поясов. Вместо этого преобразование локальное_время -> timestamptz
-- выполняется здесь, внутри PostgreSQL, единственным источником истины о
-- часовом поясе бизнеса (business_settings.timezone) — тем же, что
-- использует get_available_slots (см. 20260716130100_booking_functions.sql).
--
-- Доменный код: PB015 INVALID_BLOCK_RANGE (end_time <= start_time).
-- "Не администратор" — 42501/NOT_ADMIN, как и в admin_change_appointment_status.

create or replace function public.admin_create_schedule_block(
  p_local_date date,
  p_start_time time,
  p_end_time time,
  p_reason text default null
)
returns public.schedule_blocks
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tz text;
  v_starts_at timestamptz;
  v_ends_at timestamptz;
  v_block public.schedule_blocks;
begin
  if not public.is_admin() then
    raise exception using errcode = '42501', message = 'NOT_ADMIN';
  end if;

  if p_end_time <= p_start_time then
    raise exception using errcode = 'PB015', message = 'INVALID_BLOCK_RANGE';
  end if;

  select bs.timezone into v_tz from public.business_settings as bs where bs.id = 1;

  v_starts_at := (p_local_date::timestamp + p_start_time) at time zone v_tz;
  v_ends_at := (p_local_date::timestamp + p_end_time) at time zone v_tz;

  insert into public.schedule_blocks (starts_at, ends_at, reason)
  values (v_starts_at, v_ends_at, p_reason)
  returning * into v_block;

  return v_block;
end;
$$;

create or replace function public.admin_update_schedule_block(
  p_id uuid,
  p_local_date date,
  p_start_time time,
  p_end_time time,
  p_reason text default null
)
returns public.schedule_blocks
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tz text;
  v_starts_at timestamptz;
  v_ends_at timestamptz;
  v_block public.schedule_blocks;
begin
  if not public.is_admin() then
    raise exception using errcode = '42501', message = 'NOT_ADMIN';
  end if;

  if p_end_time <= p_start_time then
    raise exception using errcode = 'PB015', message = 'INVALID_BLOCK_RANGE';
  end if;

  select bs.timezone into v_tz from public.business_settings as bs where bs.id = 1;

  v_starts_at := (p_local_date::timestamp + p_start_time) at time zone v_tz;
  v_ends_at := (p_local_date::timestamp + p_end_time) at time zone v_tz;

  update public.schedule_blocks as sb
     set starts_at = v_starts_at,
         ends_at = v_ends_at,
         reason = p_reason
   where sb.id = p_id
  returning * into v_block;

  if not found then
    raise exception using errcode = 'PB016', message = 'SCHEDULE_BLOCK_NOT_FOUND';
  end if;

  return v_block;
end;
$$;

-- Предпросмотр конфликтов ПЕРЕД сохранением: возвращает подтверждённые
-- (confirmed) будущие записи, пересекающиеся с предполагаемой блокировкой.
-- Не создаёт и не изменяет ничего — чистое чтение для предупреждения в UI.
-- MVP: сама блокировка может быть сохранена даже при наличии конфликтов
-- (после явного подтверждения администратором в интерфейсе), существующие
-- appointments автоматически не отменяются.
create or replace function public.admin_preview_schedule_block_conflicts(
  p_local_date date,
  p_start_time time,
  p_end_time time
)
returns table (
  appointment_id uuid,
  start_at timestamptz,
  end_at timestamptz,
  service_name text
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tz text;
  v_starts_at timestamptz;
  v_ends_at timestamptz;
begin
  if not public.is_admin() then
    raise exception using errcode = '42501', message = 'NOT_ADMIN';
  end if;

  select bs.timezone into v_tz from public.business_settings as bs where bs.id = 1;

  v_starts_at := (p_local_date::timestamp + p_start_time) at time zone v_tz;
  v_ends_at := (p_local_date::timestamp + p_end_time) at time zone v_tz;

  return query
  select a.id, a.start_at, a.end_at, a.service_name_snapshot
    from public.appointments as a
   where a.status = 'confirmed'
     and a.start_at > now()
     and tstzrange(a.start_at, a.end_at, '[)')
         && tstzrange(v_starts_at, v_ends_at, '[)')
   order by a.start_at;
end;
$$;

revoke all on function
  public.admin_create_schedule_block(date, time, time, text),
  public.admin_update_schedule_block(uuid, date, time, time, text),
  public.admin_preview_schedule_block_conflicts(date, time, time)
from public, anon;

grant execute on function
  public.admin_create_schedule_block(date, time, time, text),
  public.admin_update_schedule_block(uuid, date, time, time, text),
  public.admin_preview_schedule_block_conflicts(date, time, time)
to authenticated;
