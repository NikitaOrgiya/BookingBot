-- pgTAP-тесты для GRANT, RLS и SECURITY DEFINER (Этап 1 технического
-- задания). Каждый тест проверяет ОДНО из двух условий доступа отдельно
-- (см. README, раздел "RLS и GRANT"):
--
--   1. GRANT — есть ли у роли вообще SQL-привилегия на объект;
--   2. RLS   — какие строки политика разрешает увидеть/изменить роли,
--              у которой privilege уже есть.
--
-- Запуск (расширение pgtap должно быть установлено заранее, см. README):
--   pg_prove -d bookingbot_test supabase/tests/permissions.test.sql

begin;
select no_plan();

-- ---------------------------------------------------------------------
-- Тестовые данные. Всё выполняется внутри одной транзакции и откатывается
-- в конце файла (rollback), поэтому тест воспроизводим на любой БД с
-- применёнными миграциями и не оставляет следов.
-- ---------------------------------------------------------------------

insert into auth.users (id) values
  ('00000000-0000-0000-0000-000000000001'), -- администратор
  ('00000000-0000-0000-0000-000000000002'); -- обычный пользователь Supabase Auth, не администратор

insert into public.admin_users (user_id) values
  ('00000000-0000-0000-0000-000000000001');

insert into public.services (id, name, duration_minutes, price_cents, is_active) values
  ('00000000-0000-0000-0000-0000000000a1', 'Консультация', 60, 200000, true);

insert into public.telegram_users (id, telegram_user_id) values
  ('00000000-0000-0000-0000-0000000000b1', 111);

-- business_settings — синглтон; строка может уже существовать из
-- supabase/seed.sql, поэтому тест не полагается на конкретного автора
-- строки и просто гарантирует, что она есть.
insert into public.business_settings (
  id, business_name, timezone, booking_horizon_days,
  min_booking_notice_minutes, cancellation_notice_minutes
) values (
  1, 'Test Business', 'Europe/Moscow', 14, 120, 120
)
on conflict (id) do nothing;

-- ---------------------------------------------------------------------
-- 1. GRANT: расширение btree_gist установлено.
-- ---------------------------------------------------------------------

select ok(
  exists (select 1 from pg_extension where extname = 'btree_gist'),
  'btree_gist установлен (нужен для exclusion constraint на appointments)'
);

-- ---------------------------------------------------------------------
-- 2. GRANT: точный набор табличных привилегий для anon/authenticated/
--    service_role. anon не получает вообще ничего ни на одной таблице.
-- ---------------------------------------------------------------------

select table_privs_are('public', 'admin_users', 'anon', '{}'::name[], 'anon: 0 прав на admin_users');
select table_privs_are('public', 'admin_users', 'authenticated', '{}'::name[], 'authenticated: 0 прав на admin_users');
select table_privs_are('public', 'admin_users', 'service_role', '{}'::name[], 'service_role: 0 прав на admin_users');

select table_privs_are('public', 'business_settings', 'anon', '{}'::name[], 'anon: 0 прав на business_settings');
select table_privs_are('public', 'business_settings', 'authenticated', '{SELECT,UPDATE}'::name[], 'authenticated: SELECT+UPDATE на business_settings');
select table_privs_are('public', 'business_settings', 'service_role', '{SELECT}'::name[], 'service_role: SELECT на business_settings');

select table_privs_are('public', 'services', 'anon', '{}'::name[], 'anon: 0 прав на services');
select table_privs_are('public', 'services', 'authenticated', '{SELECT,INSERT,UPDATE,DELETE}'::name[], 'authenticated: полный CRUD на services');
select table_privs_are('public', 'services', 'service_role', '{SELECT}'::name[], 'service_role: SELECT на services');

select table_privs_are('public', 'working_hours', 'anon', '{}'::name[], 'anon: 0 прав на working_hours');
select table_privs_are('public', 'working_hours', 'authenticated', '{SELECT,INSERT,UPDATE,DELETE}'::name[], 'authenticated: полный CRUD на working_hours');
select table_privs_are('public', 'working_hours', 'service_role', '{SELECT}'::name[], 'service_role: SELECT на working_hours');

select table_privs_are('public', 'schedule_blocks', 'anon', '{}'::name[], 'anon: 0 прав на schedule_blocks');
select table_privs_are('public', 'schedule_blocks', 'authenticated', '{SELECT,INSERT,UPDATE,DELETE}'::name[], 'authenticated: полный CRUD на schedule_blocks');
select table_privs_are('public', 'schedule_blocks', 'service_role', '{SELECT}'::name[], 'service_role: SELECT на schedule_blocks');

select table_privs_are('public', 'telegram_users', 'anon', '{}'::name[], 'anon: 0 прав на telegram_users');
select table_privs_are('public', 'telegram_users', 'authenticated', '{SELECT}'::name[], 'authenticated: только SELECT на telegram_users');
select table_privs_are('public', 'telegram_users', 'service_role', '{SELECT,INSERT,UPDATE}'::name[], 'service_role: SELECT+INSERT+UPDATE на telegram_users');

select table_privs_are('public', 'booking_sessions', 'anon', '{}'::name[], 'anon: 0 прав на booking_sessions');
select table_privs_are('public', 'booking_sessions', 'authenticated', '{}'::name[], 'authenticated: 0 прав на booking_sessions');
select table_privs_are('public', 'booking_sessions', 'service_role', '{SELECT,INSERT,UPDATE,DELETE}'::name[], 'service_role: полный CRUD на booking_sessions');

select table_privs_are('public', 'appointments', 'anon', '{}'::name[], 'anon: 0 прав на appointments');
select table_privs_are('public', 'appointments', 'authenticated', '{SELECT,UPDATE}'::name[], 'authenticated: SELECT+UPDATE на appointments (без INSERT/DELETE)');
select table_privs_are('public', 'appointments', 'service_role', '{SELECT,INSERT,UPDATE}'::name[], 'service_role: SELECT+INSERT+UPDATE на appointments');

select table_privs_are('public', 'processed_telegram_updates', 'anon', '{}'::name[], 'anon: 0 прав на processed_telegram_updates');
select table_privs_are('public', 'processed_telegram_updates', 'authenticated', '{}'::name[], 'authenticated: 0 прав на processed_telegram_updates');
select table_privs_are('public', 'processed_telegram_updates', 'service_role', '{SELECT,INSERT}'::name[], 'service_role: SELECT+INSERT на processed_telegram_updates');

select table_privs_are('public', 'notification_deliveries', 'anon', '{}'::name[], 'anon: 0 прав на notification_deliveries');
select table_privs_are('public', 'notification_deliveries', 'authenticated', '{SELECT}'::name[], 'authenticated: только SELECT на notification_deliveries');
select table_privs_are('public', 'notification_deliveries', 'service_role', '{SELECT,INSERT,UPDATE}'::name[], 'service_role: SELECT+INSERT+UPDATE на notification_deliveries');

-- ---------------------------------------------------------------------
-- 3. GRANT на функции: is_admin() выполняется только authenticated.
-- ---------------------------------------------------------------------

select function_privs_are('public', 'is_admin', '{}'::name[], 'anon', '{}'::name[], 'anon: не может вызывать is_admin()');
select function_privs_are('public', 'is_admin', '{}'::name[], 'authenticated', '{EXECUTE}'::name[], 'authenticated: может вызывать is_admin()');
select function_privs_are('public', 'is_admin', '{}'::name[], 'service_role', '{}'::name[], 'service_role: не нуждается в is_admin() (обходит RLS напрямую)');

-- ---------------------------------------------------------------------
-- 4. SECURITY DEFINER: is_admin() выполняется с правами владельца и с
--    фиксированным search_path (защита от подмены через search_path
--    вызывающей роли).
-- ---------------------------------------------------------------------

select ok(
  (select prosecdef from pg_proc where oid = 'public.is_admin()'::regprocedure),
  'is_admin() объявлена как SECURITY DEFINER'
);

select ok(
  (select proconfig from pg_proc where oid = 'public.is_admin()'::regprocedure)
    @> array['search_path=public, pg_temp'],
  'is_admin() имеет фиксированный search_path'
);

-- ---------------------------------------------------------------------
-- 5. RLS: включена и принудительна (FORCE) на всех рабочих таблицах,
--    кроме admin_users (там FORCE намеренно не установлен, иначе
--    is_admin() перестанет видеть свою же таблицу, см. миграцию).
-- ---------------------------------------------------------------------

select results_eq(
  $$
    select relname::text collate "C", relrowsecurity, relforcerowsecurity
    from pg_class
    where relnamespace = 'public'::regnamespace
      and relkind = 'r'
      and relname in (
        'admin_users', 'business_settings', 'services', 'working_hours',
        'schedule_blocks', 'telegram_users', 'booking_sessions',
        'appointments', 'processed_telegram_updates', 'notification_deliveries'
      )
    order by relname
  $$,
  $$
    values
      ('admin_users'::text collate "C", true, false),
      ('appointments', true, true),
      ('booking_sessions', true, true),
      ('business_settings', true, true),
      ('notification_deliveries', true, true),
      ('processed_telegram_updates', true, true),
      ('schedule_blocks', true, true),
      ('services', true, true),
      ('telegram_users', true, true),
      ('working_hours', true, true)
  $$,
  'RLS включена везде; FORCE — везде, кроме admin_users'
);

-- ---------------------------------------------------------------------
-- 6. Функциональные проверки доступа: anon не имеет доступа к рабочим
--    таблицам вообще (п. 1, 2 из раздела 16.2 ТЗ).
-- ---------------------------------------------------------------------

set role anon;
select throws_ok('select 1 from public.services', '42501', null, 'anon: SELECT из services запрещён');
select throws_ok('select 1 from public.appointments', '42501', null, 'anon: SELECT из appointments запрещён');
select throws_ok(
  $$insert into public.appointments (telegram_user_id, service_id, service_name_snapshot, duration_minutes_snapshot, start_at, end_at)
    values ('00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000a1', 'x', 30, now() + interval '1 day', now() + interval '1 day 30 minutes')$$,
  '42501', null,
  'anon: INSERT в appointments запрещён'
);
reset role;

-- ---------------------------------------------------------------------
-- 7. Неадминистратор с ролью authenticated не видит админские данные:
--    GRANT есть, но RLS отдаёт 0 строк, а не ошибку (п. 3 из раздела
--    16.2 ТЗ).
-- ---------------------------------------------------------------------

set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-000000000002';

select is(
  (select count(*)::int from public.services),
  0,
  'неадминистратор: 0 строк в services (RLS скрывает, а не запрещает SELECT)'
);
select is(
  (select count(*)::int from public.appointments),
  0,
  'неадминистратор: 0 строк в appointments'
);
select throws_ok(
  'select 1 from public.admin_users',
  '42501', null,
  'неадминистратор: admin_users недоступна вообще (нет GRANT, не только RLS)'
);
select is(
  (select public.is_admin()),
  false,
  'is_admin() возвращает false для обычного пользователя'
);

reset role;

-- ---------------------------------------------------------------------
-- 8. Администратор видит записи и может менять услуги/расписание
--    (п. 4, 5 из раздела 16.2 ТЗ).
-- ---------------------------------------------------------------------

set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-000000000001';

select is(
  (select public.is_admin()),
  true,
  'is_admin() возвращает true для администратора'
);
select is(
  (select count(*)::int from public.services),
  1,
  'администратор видит услуги'
);
select lives_ok(
  $$update public.services set price_cents = 250000 where id = '00000000-0000-0000-0000-0000000000a1'$$,
  'администратор может изменить услугу'
);
select lives_ok(
  $$insert into public.working_hours (weekday, start_time, end_time) values (0, '09:00', '18:00')$$,
  'администратор может добавить рабочий интервал'
);

-- ---------------------------------------------------------------------
-- 9. Администратор не может обойти ограничения некорректным запросом
--    (п. 6 из раздела 16.2 ТЗ): ни через CHECK-ограничения, ни минуя
--    отсутствующий у authenticated GRANT на INSERT в appointments.
-- ---------------------------------------------------------------------

select throws_ok(
  $$update public.services set duration_minutes = 0 where id = '00000000-0000-0000-0000-0000000000a1'$$,
  '23514', null,
  'администратор не может обойти CHECK-ограничение длительности услуги'
);
select throws_ok(
  $$insert into public.appointments (telegram_user_id, service_id, service_name_snapshot, duration_minutes_snapshot, start_at, end_at)
    values ('00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000a1', 'x', 30, now() + interval '1 day', now() + interval '1 day 30 minutes')$$,
  '42501', null,
  'даже администратор не может вставить запись напрямую (только через будущую reserve_appointment)'
);
select throws_ok(
  'delete from public.appointments',
  '42501', null,
  'администратор не может удалять записи (история не уничтожается)'
);
select throws_ok(
  $$update public.business_settings set reminder_first_minutes = -1 where id = 1$$,
  '23514', null,
  'администратор не может обойти CHECK-ограничение reminder_first_minutes >= 0'
);
select throws_ok(
  $$update public.business_settings set reminder_second_minutes = -1 where id = 1$$,
  '23514', null,
  'администратор не может обойти CHECK-ограничение reminder_second_minutes >= 0'
);

reset role;

-- ---------------------------------------------------------------------
-- 10. service_role: явные GRANT нужны даже несмотря на BYPASSRLS —
--     GRANT и RLS проверяются независимо (ключевой принцип раздела 9 ТЗ).
-- ---------------------------------------------------------------------

set role service_role;

select is(
  (select count(*)::int from public.services),
  1,
  'service_role видит услуги напрямую (обходит RLS, но у него есть GRANT SELECT)'
);
select lives_ok(
  $$insert into public.appointments (telegram_user_id, service_id, service_name_snapshot, duration_minutes_snapshot, price_cents_snapshot, start_at, end_at)
    values ('00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000a1', 'Консультация', 60, 200000, '2026-07-20 14:00:00+03', '2026-07-20 15:00:00+03')$$,
  'service_role может создать запись'
);

-- 11. exclusion constraint на appointments: структурная проверка, что
--     ДВЕ ПОСЛЕДОВАТЕЛЬНЫЕ вставки пересекающегося интервала не могут
--     обе существовать в таблице.
--
--     ВАЖНО: это НЕ тест на конкурентную гонку. Обе вставки здесь
--     выполняются одна за другой в одной сессии/транзакции — pgTAP не
--     умеет открывать два параллельных подключения. Этот тест доказывает
--     только то, что constraint определён правильно (что exclusion
--     constraint отклоняет пересечение вообще). Он не доказывает, что
--     constraint устоит, если два клиента нажмут "Подтвердить" в один
--     и тот же момент через два независимых соединения — для этого
--     нужен настоящий параллельный тест с двумя реальными подключениями
--     к PostgreSQL, который выполняется отдельно, в
--     tests/integration/double-booking-race.test.ts (см. README, раздел
--     "SQL-тесты и настоящий конкурентный тест").
select throws_ok(
  $$insert into public.appointments (telegram_user_id, service_id, service_name_snapshot, duration_minutes_snapshot, price_cents_snapshot, start_at, end_at)
    values ('00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000a1', 'Консультация', 60, 200000, '2026-07-20 14:30:00+03', '2026-07-20 15:30:00+03')$$,
  '23P01', null,
  'exclusion constraint (последовательно): вторая пересекающаяся вставка отклоняется (SLOT_TAKEN)'
);

-- Отмена освобождает время: тот же интервал снова становится доступен.
select lives_ok(
  $$update public.appointments set status = 'cancelled', cancelled_at = now()
    where start_at = '2026-07-20 14:00:00+03'$$,
  'отмена записи проходит успешно'
);
select lives_ok(
  $$insert into public.appointments (telegram_user_id, service_id, service_name_snapshot, duration_minutes_snapshot, price_cents_snapshot, start_at, end_at)
    values ('00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000a1', 'Консультация', 60, 200000, '2026-07-20 14:30:00+03', '2026-07-20 15:30:00+03')$$,
  'после отмены то же время снова доступно для бронирования'
);

-- 12. Идемпотентность обработки Telegram update: повторный тот же id
--     конфликтует с первичным ключом, а не создаёт вторую обработку.
select lives_ok(
  $$insert into public.processed_telegram_updates (telegram_update_id) values (555)$$,
  'первая обработка Telegram update проходит успешно'
);
select throws_ok(
  $$insert into public.processed_telegram_updates (telegram_update_id) values (555)$$,
  '23505', null,
  'повторный тот же Telegram update отклоняется первичным ключом'
);

-- 13. Одно и то же напоминание нельзя запланировать дважды для одной
--     записи: unique (appointment_id, notification_type).
select lives_ok(
  $$insert into public.notification_deliveries (appointment_id, notification_type, scheduled_for)
    select id, 'reminder_first', start_at - interval '1440 minutes'
    from public.appointments where start_at = '2026-07-20 14:30:00+03'$$,
  'первое напоминание планируется успешно'
);
select throws_ok(
  $$insert into public.notification_deliveries (appointment_id, notification_type, scheduled_for)
    select id, 'reminder_first', start_at - interval '1440 minutes'
    from public.appointments where start_at = '2026-07-20 14:30:00+03'$$,
  '23505', null,
  'повторное такое же напоминание отклоняется уникальным ограничением'
);

reset role;

select * from finish();
rollback;
