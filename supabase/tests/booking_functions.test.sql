-- pgTAP-тесты для функций ядра бронирования Этапа 2:
--   public.get_available_slots
--   public.reserve_appointment
--   public.cancel_appointment_by_client
--
-- Проверяет: расчёт слотов (обычный день, несколько интервалов, неактивная
-- услуга, минимальное уведомление, горизонт, schedule block, существующая и
-- отменённая запись, услуга не помещается, timezone-конвертация), атомарное
-- бронирование и snapshot, преобразование пересечения в 23P01, права
-- (PUBLIC/anon/authenticated не могут выполнять; service_role может), а также
-- клиентскую отмену (своя/чужая/поздняя/повторная).
--
-- Запуск (нужны PostgreSQL + расширение pgtap, см. README):
--   pg_prove -d bookingbot_test supabase/tests/booking_functions.test.sql
-- Проще всего — через `npm run test:sql`, который гоняет все *.test.sql.

begin;
select no_plan();

-- ---------------------------------------------------------------------
-- Детерминированные параметры окружения бизнеса. Всё внутри транзакции и
-- откатывается в конце (rollback).
-- ---------------------------------------------------------------------

update public.business_settings
   set timezone = 'Europe/Moscow',
       booking_horizon_days = 365,
       min_booking_notice_minutes = 0,
       cancellation_notice_minutes = 60,
       slot_step_minutes = 15
 where id = 1;

-- Опорная локальная дата: +30 дней от «сегодня» в таймзоне бизнеса —
-- заведомо в пределах горизонта и в будущем (все слоты проходят проверку
-- «не в прошлом»). wd — соответствующий weekday в схеме working_hours
-- (0 = понедельник).
create temporary table tp as
select
  ((now() at time zone 'Europe/Moscow')::date + 30) as d,
  (extract(isodow from ((now() at time zone 'Europe/Moscow')::date + 30))::int - 1) as wd;

-- Услуги: обычная 60 мин, неактивная 60 мин, длинная 121 мин.
insert into public.services (id, name, duration_minutes, price_cents, is_active) values
  ('00000000-0000-0000-0000-0000000000a1', 'Услуга 60', 60, 200000, true),
  ('00000000-0000-0000-0000-0000000000a2', 'Неактивная', 60, 100000, false),
  ('00000000-0000-0000-0000-0000000000a3', 'Длинная 121', 121, 300000, true);

-- Клиенты.
insert into public.telegram_users (id, telegram_user_id) values
  ('00000000-0000-0000-0000-0000000000b1', 111),
  ('00000000-0000-0000-0000-0000000000b2', 222);

-- Утренний рабочий интервал 10:00–12:00 в опорный weekday.
insert into public.working_hours (weekday, start_time, end_time, is_active)
select (select wd from tp), '10:00', '12:00', true;

-- =====================================================================
-- 1. Обычный рабочий день: услуга 60 мин, шаг 15, интервал 10:00–12:00.
--    Помещаются старты 10:00, 10:15, 10:30, 10:45, 11:00 = 5 слотов
--    (11:00 + 60 = 12:00 <= 12:00, полуоткрытый интервал).
-- =====================================================================
select is(
  (select count(*)::int from public.get_available_slots(
     '00000000-0000-0000-0000-0000000000a1',
     (select d from tp), (select d from tp))),
  5,
  'обычный день: 5 слотов по 60 мин с шагом 15 в 10:00-12:00'
);

-- 1a. Timezone-конвертация: первый слот начинается ровно в 10:00 локального
--     времени Москвы, приведённого к timestamptz.
select is(
  (select min(slot_start) from public.get_available_slots(
     '00000000-0000-0000-0000-0000000000a1',
     (select d from tp), (select d from tp))),
  (select (d::timestamp + time '10:00') at time zone 'Europe/Moscow' from tp),
  'timezone: первый слот = 10:00 Europe/Moscow -> timestamptz'
);

-- =====================================================================
-- 2. Несколько рабочих интервалов в один день: добавляем 14:00–15:00
--    (помещается только старт 14:00). Итого 5 + 1 = 6.
-- =====================================================================
insert into public.working_hours (weekday, start_time, end_time, is_active)
select (select wd from tp), '14:00', '15:00', true;

select is(
  (select count(*)::int from public.get_available_slots(
     '00000000-0000-0000-0000-0000000000a1',
     (select d from tp), (select d from tp))),
  6,
  'несколько интервалов: 5 (утро) + 1 (после обеда) = 6 слотов'
);

-- =====================================================================
-- 3. Неактивная услуга -> SERVICE_INACTIVE (PB002); несуществующая ->
--    SERVICE_NOT_FOUND (PB001).
-- =====================================================================
select throws_ok(
  $$ select public.get_available_slots('00000000-0000-0000-0000-0000000000a2', null, null) $$,
  'PB002', null,
  'неактивная услуга -> SERVICE_INACTIVE'
);
select throws_ok(
  $$ select public.get_available_slots('00000000-0000-0000-0000-0000000000ff', null, null) $$,
  'PB001', null,
  'несуществующая услуга -> SERVICE_NOT_FOUND'
);

-- =====================================================================
-- 4. Минимальное уведомление: если оно больше расстояния до опорной даты,
--    все слоты отсекаются.
-- =====================================================================
update public.business_settings set min_booking_notice_minutes = 576000 where id = 1; -- 400 дней
select is(
  (select count(*)::int from public.get_available_slots(
     '00000000-0000-0000-0000-0000000000a1',
     (select d from tp), (select d from tp))),
  0,
  'минимальное уведомление больше горизонта до даты -> 0 слотов'
);
update public.business_settings set min_booking_notice_minutes = 0 where id = 1;

-- =====================================================================
-- 5. Горизонт бронирования: опорная дата (+30 дней) вне горизонта в 7 дней
--    -> окно пустое -> 0 слотов.
-- =====================================================================
update public.business_settings set booking_horizon_days = 7 where id = 1;
select is(
  (select count(*)::int from public.get_available_slots(
     '00000000-0000-0000-0000-0000000000a1',
     (select d from tp), (select d from tp))),
  0,
  'дата за горизонтом бронирования -> 0 слотов'
);
update public.business_settings set booking_horizon_days = 365 where id = 1;

-- =====================================================================
-- 6. Существующая запись блокирует пересекающиеся слоты. Запись
--    10:00–11:00 убирает старты 10:00/10:15/10:30/10:45 (11:00 остаётся,
--    полуоткрытый интервал). Было 6 -> стало 2 (11:00 + 14:00).
-- =====================================================================
insert into public.appointments (
  id, telegram_user_id, service_id, service_name_snapshot,
  duration_minutes_snapshot, price_cents_snapshot, start_at, end_at, status
)
select
  '00000000-0000-0000-0000-0000000000c1',
  '00000000-0000-0000-0000-0000000000b1',
  '00000000-0000-0000-0000-0000000000a1',
  'Услуга 60', 60, 200000,
  (d::timestamp + time '10:00') at time zone 'Europe/Moscow',
  (d::timestamp + time '11:00') at time zone 'Europe/Moscow',
  'confirmed'
from tp;

select is(
  (select count(*)::int from public.get_available_slots(
     '00000000-0000-0000-0000-0000000000a1',
     (select d from tp), (select d from tp))),
  2,
  'существующая запись 10:00-11:00 блокирует 4 слота -> остаётся 2'
);

-- =====================================================================
-- 7. Отменённая запись время НЕ блокирует: возвращаемся к 6 слотам.
-- =====================================================================
update public.appointments
   set status = 'cancelled', cancelled_at = now()
 where id = '00000000-0000-0000-0000-0000000000c1';

select is(
  (select count(*)::int from public.get_available_slots(
     '00000000-0000-0000-0000-0000000000a1',
     (select d from tp), (select d from tp))),
  6,
  'отменённая запись не блокирует время -> снова 6 слотов'
);

-- =====================================================================
-- 8. schedule_block убирает пересекающиеся слоты. Блок 10:00–12:00 убирает
--    весь утренний интервал (5 слотов), остаётся 1 (14:00).
-- =====================================================================
insert into public.schedule_blocks (id, starts_at, ends_at, reason)
select
  '00000000-0000-0000-0000-0000000000d1',
  (d::timestamp + time '10:00') at time zone 'Europe/Moscow',
  (d::timestamp + time '12:00') at time zone 'Europe/Moscow',
  'тех. перерыв'
from tp;

select is(
  (select count(*)::int from public.get_available_slots(
     '00000000-0000-0000-0000-0000000000a1',
     (select d from tp), (select d from tp))),
  1,
  'schedule_block 10:00-12:00 убирает утро -> остаётся 1 слот (14:00)'
);

delete from public.schedule_blocks where id = '00000000-0000-0000-0000-0000000000d1';

-- =====================================================================
-- 9. Услуга не помещается до конца рабочего интервала: 121 мин не влезает
--    ни в 10:00–12:00 (120 мин), ни в 14:00–15:00 (60 мин) -> 0 слотов.
-- =====================================================================
select is(
  (select count(*)::int from public.get_available_slots(
     '00000000-0000-0000-0000-0000000000a3',
     (select d from tp), (select d from tp))),
  0,
  'услуга 121 мин не помещается ни в один интервал -> 0 слотов'
);

-- =====================================================================
-- 10. Права на функции: PUBLIC/anon/authenticated не имеют EXECUTE,
--     service_role имеет.
-- =====================================================================
select function_privs_are(
  'public', 'get_available_slots', array['uuid','date','date'],
  'anon', '{}'::name[], 'anon: не может выполнять get_available_slots');
select function_privs_are(
  'public', 'get_available_slots', array['uuid','date','date'],
  'authenticated', '{}'::name[], 'authenticated: не может выполнять get_available_slots');
select function_privs_are(
  'public', 'get_available_slots', array['uuid','date','date'],
  'service_role', '{EXECUTE}'::name[], 'service_role: может выполнять get_available_slots');

select function_privs_are(
  'public', 'reserve_appointment', array['bigint','uuid','timestamptz','text'],
  'anon', '{}'::name[], 'anon: не может выполнять reserve_appointment');
select function_privs_are(
  'public', 'reserve_appointment', array['bigint','uuid','timestamptz','text'],
  'authenticated', '{}'::name[], 'authenticated: не может выполнять reserve_appointment');
select function_privs_are(
  'public', 'reserve_appointment', array['bigint','uuid','timestamptz','text'],
  'service_role', '{EXECUTE}'::name[], 'service_role: может выполнять reserve_appointment');

select function_privs_are(
  'public', 'cancel_appointment_by_client', array['uuid','bigint','text'],
  'anon', '{}'::name[], 'anon: не может выполнять cancel_appointment_by_client');
select function_privs_are(
  'public', 'cancel_appointment_by_client', array['uuid','bigint','text'],
  'authenticated', '{}'::name[], 'authenticated: не может выполнять cancel_appointment_by_client');
select function_privs_are(
  'public', 'cancel_appointment_by_client', array['uuid','bigint','text'],
  'service_role', '{EXECUTE}'::name[], 'service_role: может выполнять cancel_appointment_by_client');

-- Функциональная проверка запрета: anon реально не может вызвать функцию.
set role anon;
select throws_ok(
  $$ select public.get_available_slots('00000000-0000-0000-0000-0000000000a1', null, null) $$,
  '42501', null,
  'anon: вызов get_available_slots отклонён (permission denied)'
);
reset role;

-- =====================================================================
-- Подготовка к тестам reserve/cancel: расширяем расписание вечерним
-- интервалом 16:00–20:00, чтобы были свободные слоты, не затрагивая уже
-- проверенные счётчики выше.
-- =====================================================================
insert into public.working_hours (weekday, start_time, end_time, is_active)
select (select wd from tp), '16:00', '20:00', true;

-- =====================================================================
-- 11. Атомарное бронирование и snapshot услуги. Snapshot берётся из БД, а
--     не от вызывающего; end_at = start + duration.
-- =====================================================================
create temporary table r_snap as
select * from public.reserve_appointment(
  111,
  '00000000-0000-0000-0000-0000000000a1',
  (select (d::timestamp + time '16:00') at time zone 'Europe/Moscow' from tp),
  'первый визит'
);

select is((select service_name_snapshot from r_snap), 'Услуга 60',
  'snapshot: имя услуги зафиксировано');
select is((select duration_minutes_snapshot from r_snap), 60,
  'snapshot: длительность зафиксирована');
select is((select price_cents_snapshot from r_snap), 200000,
  'snapshot: цена зафиксирована');
select is((select status from r_snap), 'confirmed',
  'новая запись создаётся в статусе confirmed');
select is(
  (select end_at from r_snap),
  (select start_at + interval '60 minutes' from r_snap),
  'end_at вычислен из duration_minutes (start + 60 мин)'
);

-- 11a. service_role реально может выполнить reserve_appointment (свободный
--      слот 16:15).
set role service_role;
select lives_ok(
  $$ select public.reserve_appointment(
       111, '00000000-0000-0000-0000-0000000000a1',
       (select (d::timestamp + time '16:15') at time zone 'Europe/Moscow' from tp),
       null) $$,
  'service_role: бронирование свободного слота проходит'
);
reset role;

-- =====================================================================
-- 12. Повторное бронирование того же слота (16:00) -> exclusion constraint
--     -> 23P01 (SLOT_TAKEN на уровне TypeScript).
-- =====================================================================
select throws_ok(
  $$ select public.reserve_appointment(
       111, '00000000-0000-0000-0000-0000000000a1',
       (select (d::timestamp + time '16:00') at time zone 'Europe/Moscow' from tp),
       null) $$,
  '23P01', null,
  'повторное бронирование занятого слота -> 23P01 (SLOT_TAKEN)'
);

-- =====================================================================
-- 13. Доменные отказы reserve_appointment.
-- =====================================================================
-- Вне рабочего расписания (21:00).
select throws_ok(
  $$ select public.reserve_appointment(
       111, '00000000-0000-0000-0000-0000000000a1',
       (select (d::timestamp + time '21:00') at time zone 'Europe/Moscow' from tp),
       null) $$,
  'PB007', null, 'reserve вне рабочих часов -> OUTSIDE_WORKING_HOURS'
);
-- За горизонтом (+400 дней).
select throws_ok(
  $$ select public.reserve_appointment(
       111, '00000000-0000-0000-0000-0000000000a1',
       (select ((d + 400)::timestamp + time '16:00') at time zone 'Europe/Moscow' from tp),
       null) $$,
  'PB005', null, 'reserve за горизонтом -> OUTSIDE_BOOKING_HORIZON'
);
-- В прошлом (минимальное уведомление 0, но старт раньше now()). Время
-- выровнено до минуты, чтобы сработала именно проверка уведомления, а не
-- INVALID_START_TIME.
select throws_ok(
  $$ select public.reserve_appointment(
       111, '00000000-0000-0000-0000-0000000000a1',
       date_trunc('minute', now() - interval '1 day'), null) $$,
  'PB006', null, 'reserve в прошлом -> MIN_NOTICE_NOT_MET'
);
-- Невыровненное начало (дробные секунды) -> INVALID_START_TIME.
select throws_ok(
  $$ select public.reserve_appointment(
       111, '00000000-0000-0000-0000-0000000000a1',
       (select (d::timestamp + time '18:00:30') at time zone 'Europe/Moscow' from tp),
       null) $$,
  'PB004', null, 'reserve с дробными секундами -> INVALID_START_TIME'
);
-- Неактивная / несуществующая услуга, несуществующий клиент.
select throws_ok(
  $$ select public.reserve_appointment(
       111, '00000000-0000-0000-0000-0000000000a2',
       (select (d::timestamp + time '18:00') at time zone 'Europe/Moscow' from tp),
       null) $$,
  'PB002', null, 'reserve неактивной услуги -> SERVICE_INACTIVE'
);
select throws_ok(
  $$ select public.reserve_appointment(
       111, '00000000-0000-0000-0000-0000000000ff',
       (select (d::timestamp + time '18:00') at time zone 'Europe/Moscow' from tp),
       null) $$,
  'PB001', null, 'reserve несуществующей услуги -> SERVICE_NOT_FOUND'
);
select throws_ok(
  $$ select public.reserve_appointment(
       999, '00000000-0000-0000-0000-0000000000a1',
       (select (d::timestamp + time '18:00') at time zone 'Europe/Moscow' from tp),
       null) $$,
  'PB003', null, 'reserve неизвестного клиента -> TELEGRAM_USER_NOT_FOUND'
);
-- schedule_block пересекает слот 17:00 -> SCHEDULE_BLOCKED.
insert into public.schedule_blocks (id, starts_at, ends_at, reason)
select
  '00000000-0000-0000-0000-0000000000d2',
  (d::timestamp + time '17:00') at time zone 'Europe/Moscow',
  (d::timestamp + time '17:30') at time zone 'Europe/Moscow',
  'блок'
from tp;
select throws_ok(
  $$ select public.reserve_appointment(
       111, '00000000-0000-0000-0000-0000000000a1',
       (select (d::timestamp + time '17:00') at time zone 'Europe/Moscow' from tp),
       null) $$,
  'PB008', null, 'reserve в заблокированное время -> SCHEDULE_BLOCKED'
);
delete from public.schedule_blocks where id = '00000000-0000-0000-0000-0000000000d2';

-- =====================================================================
-- 14. Отмена своей записи: статус cancelled, cancelled_at заполнен.
-- =====================================================================
create temporary table r_own as
select * from public.reserve_appointment(
  111, '00000000-0000-0000-0000-0000000000a1',
  (select (d::timestamp + time '18:00') at time zone 'Europe/Moscow' from tp),
  null
);

create temporary table r_cancelled as
select * from public.cancel_appointment_by_client(
  (select id from r_own), 111, 'передумал'
);

select is((select status from r_cancelled), 'cancelled',
  'отмена своей записи: статус cancelled');
select ok((select cancelled_at is not null from r_cancelled),
  'отмена своей записи: cancelled_at заполнен');
select is((select cancel_reason from r_cancelled), 'передумал',
  'отмена своей записи: причина сохранена');

-- 14a. Повторная отмена уже отменённой -> ALREADY_CANCELLED (PB012).
select throws_ok(
  format(
    $$ select public.cancel_appointment_by_client(%L, 111, null) $$,
    (select id from r_own)
  ),
  'PB012', null, 'повторная отмена -> ALREADY_CANCELLED'
);

-- =====================================================================
-- 15. Нельзя отменить чужую запись -> APPOINTMENT_NOT_OWNED (PB010).
-- =====================================================================
create temporary table r_other as
select * from public.reserve_appointment(
  111, '00000000-0000-0000-0000-0000000000a1',
  (select (d::timestamp + time '18:15') at time zone 'Europe/Moscow' from tp),
  null
);
select throws_ok(
  format(
    $$ select public.cancel_appointment_by_client(%L, 222, null) $$,
    (select id from r_other)
  ),
  'PB010', null, 'отмена чужой записи клиентом 222 -> APPOINTMENT_NOT_OWNED'
);

-- 15a. Несуществующая запись -> APPOINTMENT_NOT_FOUND (PB009).
select throws_ok(
  $$ select public.cancel_appointment_by_client(
       '00000000-0000-0000-0000-0000000000ee', 111, null) $$,
  'PB009', null, 'отмена несуществующей записи -> APPOINTMENT_NOT_FOUND'
);

-- =====================================================================
-- 16. Слишком поздняя отмена -> CANCELLATION_TOO_LATE (PB011). Ставим
--     огромный cancellation_notice_minutes, при котором до начала записи
--     (через ~30 дней) уже «поздно».
-- =====================================================================
create temporary table r_late as
select * from public.reserve_appointment(
  111, '00000000-0000-0000-0000-0000000000a1',
  (select (d::timestamp + time '19:00') at time zone 'Europe/Moscow' from tp),
  null
);
update public.business_settings set cancellation_notice_minutes = 576000 where id = 1; -- 400 дней
select throws_ok(
  format(
    $$ select public.cancel_appointment_by_client(%L, 111, null) $$,
    (select id from r_late)
  ),
  'PB011', null, 'отмена позже допустимого срока -> CANCELLATION_TOO_LATE'
);
update public.business_settings set cancellation_notice_minutes = 60 where id = 1;

select * from finish();
rollback;
