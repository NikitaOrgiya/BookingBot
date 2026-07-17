-- Этап 4, корректирующая миграция по итогам аудита. Не переписывает
-- 20260717090400_admin_schedule_block_functions.sql задним числом —
-- переиздаёт admin_update_schedule_block через CREATE OR REPLACE (это
-- обычный, ожидаемый способ эволюции функций между миграциями в этом
-- проекте, см. is_admin() в 20260716100200_is_admin_function.sql) и
-- добавляет новую функцию admin_delete_schedule_block.
--
-- Проблема: прошедшая или уже начавшаяся блокировка расписания могла быть
-- изменена или удалена администратором — это искажает исторический факт
-- (блокировка действовала в прошлом ровно так, как была создана) и в
-- случае удаления могло бы "задним числом" открыть уже прошедшее время.
--
-- Новый доменный код: PB017 PAST_SCHEDULE_BLOCK_IMMUTABLE.

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
  v_existing public.schedule_blocks;
  v_block public.schedule_blocks;
begin
  if not public.is_admin() then
    raise exception using errcode = '42501', message = 'NOT_ADMIN';
  end if;

  if p_end_time <= p_start_time then
    raise exception using errcode = 'PB015', message = 'INVALID_BLOCK_RANGE';
  end if;

  -- Блокируем строку на время проверки "не началась ли уже" — конкурентное
  -- изменение той же блокировки не должно гоняться с этой проверкой.
  select *
    into v_existing
    from public.schedule_blocks as sb
   where sb.id = p_id
   for update;

  if not found then
    raise exception using errcode = 'PB016', message = 'SCHEDULE_BLOCK_NOT_FOUND';
  end if;

  if v_existing.starts_at <= now() then
    raise exception using errcode = 'PB017', message = 'PAST_SCHEDULE_BLOCK_IMMUTABLE';
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

  return v_block;
end;
$$;

-- Предпросмотр конфликтов и создание блокировки (admin_create_schedule_block,
-- admin_preview_schedule_block_conflicts) не тронуты: "прошлое" их не
-- касается — создать блокировку в прошлом технически можно (это не меняет
-- уже случившийся факт истории), запрет — только на ИЗМЕНЕНИЕ/УДАЛЕНИЕ уже
-- существующей блокировки, если она уже наступила.

create or replace function public.admin_delete_schedule_block(p_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_existing public.schedule_blocks;
begin
  if not public.is_admin() then
    raise exception using errcode = '42501', message = 'NOT_ADMIN';
  end if;

  select *
    into v_existing
    from public.schedule_blocks as sb
   where sb.id = p_id
   for update;

  if not found then
    raise exception using errcode = 'PB016', message = 'SCHEDULE_BLOCK_NOT_FOUND';
  end if;

  if v_existing.starts_at <= now() then
    raise exception using errcode = 'PB017', message = 'PAST_SCHEDULE_BLOCK_IMMUTABLE';
  end if;

  delete from public.schedule_blocks where id = p_id;
end;
$$;

revoke all on function public.admin_delete_schedule_block(uuid) from public, anon;
grant execute on function public.admin_delete_schedule_block(uuid) to authenticated;

-- Панель теперь удаляет блокировки только через admin_delete_schedule_block
-- (проверяет is_admin() и неизменяемость прошедших блокировок сама,
-- SECURITY DEFINER) — прямой DELETE от authenticated больше не нужен и
-- обходил бы проверку "блокировка уже наступила".
revoke delete on table public.schedule_blocks from authenticated;
