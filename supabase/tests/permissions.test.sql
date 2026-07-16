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
select table_privs_are('public', 'processed_telegram_updates', 'service_role', '{SELECT,INSERT,UPDATE}'::name[], 'service_role: SELECT+INSERT+UPDATE на processed_telegram_updates (crash-safe lease-модель claim/complete/release, корректирующий аудит Этапа 3 — без DELETE)');

select table_privs_are('public', 'notification_deliveries', 'anon', '{}'::name[], 'anon: 0 прав на notification_deliveries');
select table_privs_are('public', 'notification_deliveries', 'authenticated', '{SELECT}'::name[], 'authenticated: только SELECT на notification_deliveries');
select table_privs_are('public', 'notification_deliveries', 'service_role', '{SELECT,INSERT,UPDATE}'::name[], 'service_role: SELECT+INSERT+UPDATE на notification_deliveries');

-- ---------------------------------------------------------------------
-- 3. GRANT на функции: is_admin() выполняется только authenticated.
-- ---------------------------------------------------------------------

select function_privs_are('public', 'is_admin', '{}'::name[], 'anon', '{}'::name[], 'anon: не может вызывать is_admin()');
select function_privs_are('public', 'is_admin', '{}'::name[], 'authenticated', '{EXECUTE}'::name[], 'authenticated: может вызывать is_admin()');
select function_privs_are('public', 'is_admin', '{}'::name[], 'service_role', '{}'::name[], 'service_role: не нуждается в is_admin() (обходит RLS напрямую)');

-- 3a. GRANT на функции crash-safe lease-модели идемпотентности
--     (claim_telegram_update/complete_telegram_update/release_telegram_update,
--     корректирующий аудит Этапа 3) — только service_role, как и у ядра
--     бронирования (reserve_appointment/cancel_appointment_by_client).
select function_privs_are('public', 'claim_telegram_update', '{bigint,integer}'::name[], 'anon', '{}'::name[], 'anon: не может вызывать claim_telegram_update()');
select function_privs_are('public', 'claim_telegram_update', '{bigint,integer}'::name[], 'authenticated', '{}'::name[], 'authenticated: не может вызывать claim_telegram_update()');
select function_privs_are('public', 'claim_telegram_update', '{bigint,integer}'::name[], 'service_role', '{EXECUTE}'::name[], 'service_role: может вызывать claim_telegram_update()');

select function_privs_are('public', 'complete_telegram_update', '{bigint,uuid}'::name[], 'anon', '{}'::name[], 'anon: не может вызывать complete_telegram_update()');
select function_privs_are('public', 'complete_telegram_update', '{bigint,uuid}'::name[], 'authenticated', '{}'::name[], 'authenticated: не может вызывать complete_telegram_update()');
select function_privs_are('public', 'complete_telegram_update', '{bigint,uuid}'::name[], 'service_role', '{EXECUTE}'::name[], 'service_role: может вызывать complete_telegram_update()');

select function_privs_are('public', 'release_telegram_update', '{bigint,uuid,text}'::name[], 'anon', '{}'::name[], 'anon: не может вызывать release_telegram_update()');
select function_privs_are('public', 'release_telegram_update', '{bigint,uuid,text}'::name[], 'authenticated', '{}'::name[], 'authenticated: не может вызывать release_telegram_update()');
select function_privs_are('public', 'release_telegram_update', '{bigint,uuid,text}'::name[], 'service_role', '{EXECUTE}'::name[], 'service_role: может вызывать release_telegram_update()');

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

-- 12. Идемпотентность обработки Telegram update: crash-safe lease-модель
--     claim/complete/release (корректирующий аудит Этапа 3, заменяет
--     прежнюю модель claim/release на DELETE — см. lib/telegram/
--     idempotency.ts и supabase/migrations/
--     20260716140000_processed_telegram_updates_claim_retry.sql). Токены
--     claim'ов сохраняются во временную таблицу, чтобы сравнивать их между
--     последовательными вызовами внутри одного теста.

create temporary table test_claim_capture (label text primary key, token uuid);

-- 12a. Новый update_id: claimed, с непустым claim_token.
insert into test_claim_capture
  select 'new-claim', claim_token from public.claim_telegram_update(700);

select isnt(
  (select token from test_claim_capture where label = 'new-claim'),
  null,
  'claim нового update_id возвращает непустой claim_token'
);

-- 12b. Тот же update_id прямо сейчас (lease ещё не истёк): busy, а не
-- повторный claimed и не completed. claim_token для busy должен быть null.
select is(
  (select result from public.claim_telegram_update(700)),
  'busy',
  'повторный claim того же update_id с ещё не истёкшим lease: busy'
);
select is(
  (select claim_token from public.claim_telegram_update(700)),
  null,
  'busy: claim_token в результате отсутствует (null)'
);

-- 12c. complete/release со случайным (заведомо неверным) claim_token не
-- проходят и не меняют состояние строки.
select is(
  (select public.complete_telegram_update(700, gen_random_uuid())),
  false,
  'complete со случайным неверным claim_token: false, ничего не завершает'
);
select is(
  (select public.release_telegram_update(700, gen_random_uuid())),
  false,
  'release со случайным неверным claim_token: false, ничего не освобождает'
);
select is(
  (select result from public.claim_telegram_update(700)),
  'busy',
  'после неудачных complete/release состояние не изменилось: всё ещё busy'
);

-- 12d. complete с ВЕРНЫМ claim_token переводит в 'completed' навсегда.
select is(
  (select public.complete_telegram_update(700, (select token from test_claim_capture where label = 'new-claim'))),
  true,
  'complete с верным claim_token: true'
);
select is(
  (select result from public.claim_telegram_update(700)),
  'completed',
  'после complete: claim того же update_id снова -> completed (навсегда, не перезахватывается)'
);
select is(
  (select public.complete_telegram_update(700, (select token from test_claim_capture where label = 'new-claim'))),
  false,
  'повторный complete того же (уже completed) claim_token: false (status уже не processing)'
);

-- 12e. release с ВЕРНЫМ claim_token после обычной (пойманной в JS) ошибки
-- разрешает немедленный re-claim (retry Telegram при 5xx) — без ожидания
-- истечения исходного lease.
insert into test_claim_capture
  select 'release-before', claim_token from public.claim_telegram_update(701);

select is(
  (select public.release_telegram_update(701, (select token from test_claim_capture where label = 'release-before'))),
  true,
  'release с верным claim_token: true'
);

insert into test_claim_capture
  select 'release-after', claim_token from public.claim_telegram_update(701);

select isnt(
  (select token from test_claim_capture where label = 'release-before'),
  (select token from test_claim_capture where label = 'release-after'),
  're-claim после release выдаёт НОВЫЙ claim_token, отличный от освобождённого'
);
select is(
  (select public.release_telegram_update(701, (select token from test_claim_capture where label = 'release-before'))),
  false,
  'старый (уже использованный) claim_token не может повторно release перезахваченный claim'
);
select is(
  (select public.complete_telegram_update(701, (select token from test_claim_capture where label = 'release-before'))),
  false,
  'старый (уже использованный) claim_token не может complete перезахваченный claim'
);
select is(
  (select public.complete_telegram_update(701, (select token from test_claim_capture where label = 'release-after'))),
  true,
  'актуальный (после re-claim) claim_token успешно завершает claim'
);

-- 12f. Авария (SIGKILL/serverless timeout): ни complete, ни release не
-- вызываются вовсе. Симулируем истечение lease напрямую (locked_until в
-- прошлом) — теперь это возможно, потому что service_role получил UPDATE
-- на эту таблицу именно для lease-модели (см. раздел GRANT выше). Update
-- НЕ должен быть похоронен навсегда: перезахват обязан пройти с новым
-- claim_token, а старый (осиротевший) — не может ни complete, ни release
-- перезахваченный claim.
insert into test_claim_capture
  select 'crash-before', claim_token from public.claim_telegram_update(702);

update public.processed_telegram_updates
   set locked_until = now() - interval '1 second'
 where telegram_update_id = 702;

insert into test_claim_capture
  select 'crash-after', claim_token from public.claim_telegram_update(702);

select isnt(
  (select token from test_claim_capture where label = 'crash-before'),
  (select token from test_claim_capture where label = 'crash-after'),
  'перезахват просроченного (аварийно "зависшего") lease выдаёт НОВЫЙ claim_token'
);
select is(
  (select public.complete_telegram_update(702, (select token from test_claim_capture where label = 'crash-before'))),
  false,
  '"осиротевший" (аварийный) claim_token НЕ может complete claim, перезахваченный другим воркером'
);
select is(
  (select public.release_telegram_update(702, (select token from test_claim_capture where label = 'crash-before'))),
  false,
  '"осиротевший" (аварийный) claim_token НЕ может release claim, перезахваченный другим воркером'
);
select is(
  (select public.complete_telegram_update(702, (select token from test_claim_capture where label = 'crash-after'))),
  true,
  'актуальный (после перезахвата) claim_token успешно завершает claim — update не похоронен навсегда'
);
select is(
  (select result from public.claim_telegram_update(702)),
  'completed',
  'update, переживший симулированную аварию, в итоге корректно завершён (completed)'
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
