-- Этап 2. Ядро бронирования: доступные слоты, атомарная резервация и
-- клиентская отмена. Все три функции предназначены ТОЛЬКО для серверного
-- Telegram-бота (роль service_role) и недоступны anon/authenticated.
--
-- Модель безопасности каждой функции:
--   * SECURITY INVOKER (по умолчанию) — SECURITY DEFINER намеренно НЕ
--     используется: единственный вызывающий, service_role, уже имеет
--     BYPASSRLS и все необходимые табличные GRANT (SELECT на справочниках,
--     INSERT/UPDATE на appointments). Повышать права незачем — это самый
--     консервативный вариант;
--   * фиксированный search_path = public, pg_temp — вызывающая роль не
--     может подменить объекты через свой search_path;
--   * все объекты адресуются по полному имени public.*;
--   * REVOKE ALL FROM public/anon/authenticated, GRANT EXECUTE только
--     service_role (см. конец файла и privilege-audit в следующей
--     миграции).
--
-- Доменные ошибки сигнализируются кастомным SQLSTATE класса 'PB' (класс за
-- пределами зарезервированного стандартом диапазона A-H) плюс стабильным
-- текстом MESSAGE, равным доменному коду. Серверный TypeScript-слой
-- (lib/booking) сопоставляет SQLSTATE с доменным кодом; сырой текст
-- PostgreSQL клиенту не показывается. Конкурентное двойное бронирование —
-- отдельный случай: оно ловится не проверкой, а exclusion constraint на
-- appointments (native SQLSTATE 23P01), который TypeScript преобразует в
-- SLOT_TAKEN.
--
--   PB001 SERVICE_NOT_FOUND
--   PB002 SERVICE_INACTIVE
--   PB003 TELEGRAM_USER_NOT_FOUND
--   PB004 INVALID_START_TIME
--   PB005 OUTSIDE_BOOKING_HORIZON
--   PB006 MIN_NOTICE_NOT_MET
--   PB007 OUTSIDE_WORKING_HOURS
--   PB008 SCHEDULE_BLOCKED
--   PB009 APPOINTMENT_NOT_FOUND
--   PB010 APPOINTMENT_NOT_OWNED
--   PB011 CANCELLATION_TOO_LATE
--   PB012 ALREADY_CANCELLED
--   23P01 SLOT_TAKEN (native exclusion_violation)

-- =====================================================================
-- get_available_slots
-- =====================================================================
--
-- Возвращает свободные слоты для активной услуги в окне бронирования,
-- используя полуоткрытую семантику интервалов [start, end).
--
-- Вход:
--   p_service_id  uuid  — услуга (должна существовать и быть активной);
--   p_from_date   date  — нижняя граница окна (локальная дата бизнеса),
--                         по умолчанию сегодня; клампится к «сегодня»;
--   p_to_date     date  — верхняя граница окна (локальная дата бизнеса),
--                         по умолчанию последний день горизонта; клампится
--                         к горизонту booking_horizon_days.
--
-- Выход: множество строк (slot_start timestamptz, slot_end timestamptz),
-- отсортированных по возрастанию slot_start.
--
-- Учитывает: длительность услуги, timezone и booking_horizon_days из
-- business_settings, min_booking_notice_minutes, недельное расписание
-- working_hours (несколько интервалов в день), schedule_blocks, активные
-- appointments (confirmed/completed/no_show), корректные переходы
-- локальное_время <-> timestamptz (каждый локальный слот конвертируется
-- независимо, что верно и при переходах DST). Начало и конец услуги
-- обязаны целиком помещаться в один рабочий интервал. Отменённые записи
-- время не блокируют. Прошедшие слоты и слоты раньше минимального
-- уведомления не возвращаются.

create or replace function public.get_available_slots(
  p_service_id uuid,
  p_from_date date default null,
  p_to_date date default null
)
returns table (
  slot_start timestamptz,
  slot_end timestamptz
)
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_tz text;
  v_horizon_days integer;
  v_min_notice integer;
  v_step integer;
  v_duration integer;
  v_is_active boolean;
  v_now timestamptz := now();
  v_today_local date;
  v_horizon_last date;
  v_from date;
  v_to date;
begin
  select bs.timezone,
         bs.booking_horizon_days,
         bs.min_booking_notice_minutes,
         bs.slot_step_minutes
    into v_tz, v_horizon_days, v_min_notice, v_step
    from public.business_settings as bs
   where bs.id = 1;

  select s.duration_minutes, s.is_active
    into v_duration, v_is_active
    from public.services as s
   where s.id = p_service_id;

  if not found then
    raise exception using errcode = 'PB001', message = 'SERVICE_NOT_FOUND';
  end if;
  if not v_is_active then
    raise exception using errcode = 'PB002', message = 'SERVICE_INACTIVE';
  end if;

  v_today_local := (v_now at time zone v_tz)::date;
  v_horizon_last := v_today_local + v_horizon_days;

  v_from := coalesce(p_from_date, v_today_local);
  v_to := coalesce(p_to_date, v_horizon_last);

  -- Кламп окна: не раньше сегодняшней локальной даты и не позже горизонта.
  if v_from < v_today_local then
    v_from := v_today_local;
  end if;
  if v_to > v_horizon_last then
    v_to := v_horizon_last;
  end if;

  return query
  with days as (
    select (v_from + g.offset_days) as local_date
    from generate_series(0, (v_to - v_from)) as g(offset_days)
  ),
  day_intervals as (
    select d.local_date,
           wh.start_time,
           wh.end_time
    from days as d
    join public.working_hours as wh
      on wh.is_active
     and wh.weekday = (extract(isodow from d.local_date)::int - 1)
  ),
  candidates as (
    select
      (
        di.local_date::timestamp
        + di.start_time
        + make_interval(mins => gs.n * v_step)
      ) as local_start_naive
    from day_intervals as di
    cross join lateral generate_series(
      0,
      floor(
        (extract(epoch from (di.end_time - di.start_time)) / 60.0 - v_duration)
        / v_step
      )::int
    ) as gs(n)
  ),
  resolved as (
    select
      (c.local_start_naive at time zone v_tz) as slot_start,
      (c.local_start_naive at time zone v_tz)
        + make_interval(mins => v_duration) as slot_end
    from candidates as c
  )
  select r.slot_start, r.slot_end
  from resolved as r
  where r.slot_start >= v_now + make_interval(mins => v_min_notice)
    and not exists (
      select 1
      from public.schedule_blocks as sb
      where tstzrange(sb.starts_at, sb.ends_at, '[)')
            && tstzrange(r.slot_start, r.slot_end, '[)')
    )
    and not exists (
      select 1
      from public.appointments as a
      where a.status in ('confirmed', 'completed', 'no_show')
        and tstzrange(a.start_at, a.end_at, '[)')
            && tstzrange(r.slot_start, r.slot_end, '[)')
    )
  order by r.slot_start;
end;
$$;

-- =====================================================================
-- reserve_appointment
-- =====================================================================
--
-- Атомарно создаёт запись. Snapshot-поля (имя, длительность, цена услуги)
-- берутся ТОЛЬКО из серверного чтения services и никогда не принимаются от
-- вызывающего кода. end_at вычисляется из duration_minutes услуги.
-- Окончательная защита от конкурентного двойного бронирования — exclusion
-- constraint на appointments: пересекающаяся вставка падает с 23P01,
-- ошибка НЕ гасится здесь, а пробрасывается в TypeScript-слой (SLOT_TAKEN).
--
-- Вход:
--   p_telegram_user_id  bigint  — внешний Telegram-идентификатор клиента;
--   p_service_id        uuid    — услуга;
--   p_start_at          timestamptz — начало (должно попадать в сетку слотов);
--   p_client_note       text    — необязательный комментарий клиента.
--
-- Выход: созданная строка public.appointments.

create or replace function public.reserve_appointment(
  p_telegram_user_id bigint,
  p_service_id uuid,
  p_start_at timestamptz,
  p_client_note text default null
)
returns public.appointments
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_tz text;
  v_horizon_days integer;
  v_min_notice integer;
  v_user_row_id uuid;
  v_service_name text;
  v_duration integer;
  v_price integer;
  v_is_active boolean;
  v_now timestamptz := now();
  v_end timestamptz;
  v_local_start timestamp;
  v_local_end timestamp;
  v_appt public.appointments;
begin
  if p_start_at is null then
    raise exception using errcode = 'PB004', message = 'INVALID_START_TIME';
  end if;
  -- Начало должно быть выровнено хотя бы до целой минуты (сетка слотов
  -- всегда кратна минутам). Дробные секунды — признак некорректного входа.
  if p_start_at <> date_trunc('minute', p_start_at) then
    raise exception using errcode = 'PB004', message = 'INVALID_START_TIME';
  end if;

  select tu.id
    into v_user_row_id
    from public.telegram_users as tu
   where tu.telegram_user_id = p_telegram_user_id;
  if not found then
    raise exception using errcode = 'PB003', message = 'TELEGRAM_USER_NOT_FOUND';
  end if;

  select s.name, s.duration_minutes, s.price_cents, s.is_active
    into v_service_name, v_duration, v_price, v_is_active
    from public.services as s
   where s.id = p_service_id;
  if not found then
    raise exception using errcode = 'PB001', message = 'SERVICE_NOT_FOUND';
  end if;
  if not v_is_active then
    raise exception using errcode = 'PB002', message = 'SERVICE_INACTIVE';
  end if;

  select bs.timezone, bs.booking_horizon_days, bs.min_booking_notice_minutes
    into v_tz, v_horizon_days, v_min_notice
    from public.business_settings as bs
   where bs.id = 1;

  v_end := p_start_at + make_interval(mins => v_duration);

  -- Минимальное уведомление (покрывает и «слот в прошлом», т.к. notice >= 0).
  if p_start_at < v_now + make_interval(mins => v_min_notice) then
    raise exception using errcode = 'PB006', message = 'MIN_NOTICE_NOT_MET';
  end if;

  -- Горизонт бронирования по локальной дате бизнеса.
  if (p_start_at at time zone v_tz)::date
       > ((v_now at time zone v_tz)::date + v_horizon_days) then
    raise exception using errcode = 'PB005', message = 'OUTSIDE_BOOKING_HORIZON';
  end if;

  -- Попадание в рабочее расписание: [start, end) целиком помещается в один
  -- активный рабочий интервал того же локального дня.
  v_local_start := p_start_at at time zone v_tz;
  v_local_end := v_end at time zone v_tz;

  if not exists (
    select 1
    from public.working_hours as wh
    where wh.is_active
      and wh.weekday = (extract(isodow from v_local_start)::int - 1)
      and v_local_start::time >= wh.start_time
      and v_local_end::time <= wh.end_time
      and v_local_start::date = v_local_end::date
  ) then
    raise exception using errcode = 'PB007', message = 'OUTSIDE_WORKING_HOURS';
  end if;

  -- Разовые блокировки расписания.
  if exists (
    select 1
    from public.schedule_blocks as sb
    where tstzrange(sb.starts_at, sb.ends_at, '[)')
          && tstzrange(p_start_at, v_end, '[)')
  ) then
    raise exception using errcode = 'PB008', message = 'SCHEDULE_BLOCKED';
  end if;

  -- Вставка. Snapshot-поля — исключительно из серверного чтения услуги.
  -- Пересечение с активной записью здесь НЕ проверяется вручную: финальное
  -- решение принимает exclusion constraint (23P01 -> SLOT_TAKEN).
  insert into public.appointments (
    telegram_user_id,
    service_id,
    service_name_snapshot,
    duration_minutes_snapshot,
    price_cents_snapshot,
    start_at,
    end_at,
    status,
    client_note
  ) values (
    v_user_row_id,
    p_service_id,
    v_service_name,
    v_duration,
    v_price,
    p_start_at,
    v_end,
    'confirmed',
    p_client_note
  )
  returning * into v_appt;

  return v_appt;
end;
$$;

-- =====================================================================
-- cancel_appointment_by_client
-- =====================================================================
--
-- Клиентская отмена. Не удаляет строку (история сохраняется), а переводит
-- статус в 'cancelled', заполняет cancelled_at и, при наличии, cancel_reason.
-- Проверяет принадлежность записи вызывающему клиенту и соблюдение
-- cancellation_notice_minutes. Повторная отмена уже отменённой записи
-- отклоняется доменным кодом ALREADY_CANCELLED (идемпотентно-предсказуемо).
--
-- Вход:
--   p_appointment_id    uuid    — запись;
--   p_telegram_user_id  bigint  — внешний Telegram-идентификатор клиента;
--   p_reason            text    — необязательная причина отмены.
--
-- Выход: отменённая строка public.appointments.

create or replace function public.cancel_appointment_by_client(
  p_appointment_id uuid,
  p_telegram_user_id bigint,
  p_reason text default null
)
returns public.appointments
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_user_row_id uuid;
  v_cancel_notice integer;
  v_now timestamptz := now();
  v_appt public.appointments;
begin
  select tu.id
    into v_user_row_id
    from public.telegram_users as tu
   where tu.telegram_user_id = p_telegram_user_id;
  if not found then
    raise exception using errcode = 'PB003', message = 'TELEGRAM_USER_NOT_FOUND';
  end if;

  -- Блокируем строку на время проверок, чтобы параллельные попытки отмены
  -- не гонялись между собой.
  select *
    into v_appt
    from public.appointments as a
   where a.id = p_appointment_id
   for update;
  if not found then
    raise exception using errcode = 'PB009', message = 'APPOINTMENT_NOT_FOUND';
  end if;

  if v_appt.telegram_user_id <> v_user_row_id then
    raise exception using errcode = 'PB010', message = 'APPOINTMENT_NOT_OWNED';
  end if;

  if v_appt.status = 'cancelled' then
    raise exception using errcode = 'PB012', message = 'ALREADY_CANCELLED';
  end if;

  select bs.cancellation_notice_minutes
    into v_cancel_notice
    from public.business_settings as bs
   where bs.id = 1;

  -- Слишком поздняя отмена: до начала осталось меньше требуемого запаса.
  -- Завершённые/no_show записи (start_at уже в прошлом) тоже отсекаются
  -- этим же условием.
  if v_appt.start_at - v_now < make_interval(mins => v_cancel_notice) then
    raise exception using errcode = 'PB011', message = 'CANCELLATION_TOO_LATE';
  end if;

  update public.appointments as a
     set status = 'cancelled',
         cancelled_at = v_now,
         cancel_reason = p_reason
   where a.id = p_appointment_id
  returning * into v_appt;

  return v_appt;
end;
$$;

-- =====================================================================
-- Права на функции ядра бронирования.
-- =====================================================================
-- PostgreSQL по умолчанию выдаёт EXECUTE роли PUBLIC на каждую новую
-- функцию — явно отзываем и выдаём только серверной роли бота.

revoke all on function
  public.get_available_slots(uuid, date, date),
  public.reserve_appointment(bigint, uuid, timestamptz, text),
  public.cancel_appointment_by_client(uuid, bigint, text)
from public, anon, authenticated;

grant execute on function
  public.get_available_slots(uuid, date, date),
  public.reserve_appointment(bigint, uuid, timestamptz, text),
  public.cancel_appointment_by_client(uuid, bigint, text)
to service_role;
