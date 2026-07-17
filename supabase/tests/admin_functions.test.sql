-- pgTAP-тесты для административных объектов Этапа 4:
--   public.admin_change_appointment_status
--   public.admin_create_schedule_block / admin_update_schedule_block /
--     admin_preview_schedule_block_conflicts
--   сужение GRANT на appointments/services
--   working_hours_no_overlap_active (exclusion constraint)
--   business_settings CHECK-валидация (timezone, business_name)
--
-- Запуск (нужны PostgreSQL + расширение pgtap, см. README):
--   pg_prove -d bookingbot_test supabase/tests/admin_functions.test.sql
-- Проще всего — через `npm run test:sql`, который гоняет все *.test.sql.

begin;
select no_plan();

-- ---------------------------------------------------------------------
-- Тестовые данные. Всё внутри транзакции и откатывается в конце
-- (rollback) — воспроизводимо на любой БД с применёнными миграциями.
-- ---------------------------------------------------------------------

insert into auth.users (id) values
  ('00000000-0000-0000-0000-000000000101'), -- администратор
  ('00000000-0000-0000-0000-000000000102'); -- обычный пользователь, не администратор

insert into public.admin_users (user_id) values
  ('00000000-0000-0000-0000-000000000101');

insert into public.services (id, name, duration_minutes, price_cents, is_active) values
  ('00000000-0000-0000-0000-0000000000c1', 'Тестовая услуга Этапа 4', 60, 200000, true);

insert into public.telegram_users (id, telegram_user_id) values
  ('00000000-0000-0000-0000-0000000000c2', 4001);

-- Три записи: c3 (переводится в completed), c4 (переводится в cancelled),
-- c5 (остаётся confirmed) — заведены здесь, ДО переключения на роль
-- authenticated (у неё никогда не было и не должно быть INSERT на
-- appointments — единственный писатель этой таблицы, помимо владельца
-- миграций, это service_role через reserve_appointment).
insert into public.appointments (
  id, telegram_user_id, service_id, service_name_snapshot,
  duration_minutes_snapshot, price_cents_snapshot, start_at, end_at, status
) values
  ('00000000-0000-0000-0000-0000000000c3',
   '00000000-0000-0000-0000-0000000000c2',
   '00000000-0000-0000-0000-0000000000c1',
   'Тестовая услуга Этапа 4', 60, 200000,
   now() + interval '2 days', now() + interval '2 days 1 hour',
   'confirmed'),
  ('00000000-0000-0000-0000-0000000000c4',
   '00000000-0000-0000-0000-0000000000c2',
   '00000000-0000-0000-0000-0000000000c1',
   'Тестовая услуга Этапа 4', 60, 200000,
   now() + interval '3 days', now() + interval '3 days 1 hour',
   'confirmed'),
  ('00000000-0000-0000-0000-0000000000c5',
   '00000000-0000-0000-0000-0000000000c2',
   '00000000-0000-0000-0000-0000000000c1',
   'Тестовая услуга Этапа 4', 60, 200000,
   now() + interval '4 days', now() + interval '4 days 1 hour',
   'confirmed');

update public.business_settings set timezone = 'Europe/Moscow' where id = 1;

-- ---------------------------------------------------------------------
-- 1. GRANT: новые административные функции недоступны anon/PUBLIC/
--    service_role — выполнять их может только authenticated (сама
--    функция уже проверяет is_admin() внутри).
-- ---------------------------------------------------------------------

select function_privs_are(
  'public', 'admin_change_appointment_status', '{uuid,text,text}'::name[],
  'anon', '{}'::name[], 'anon: не может вызывать admin_change_appointment_status()'
);
select function_privs_are(
  'public', 'admin_change_appointment_status', '{uuid,text,text}'::name[],
  'authenticated', '{EXECUTE}'::name[], 'authenticated: может вызывать admin_change_appointment_status()'
);
select function_privs_are(
  'public', 'admin_change_appointment_status', '{uuid,text,text}'::name[],
  'service_role', '{}'::name[], 'service_role: не нуждается в admin_change_appointment_status()'
);

select function_privs_are(
  'public', 'admin_create_schedule_block', '{date,time,time,text}'::name[],
  'anon', '{}'::name[], 'anon: не может вызывать admin_create_schedule_block()'
);
select function_privs_are(
  'public', 'admin_create_schedule_block', '{date,time,time,text}'::name[],
  'authenticated', '{EXECUTE}'::name[], 'authenticated: может вызывать admin_create_schedule_block()'
);

select function_privs_are(
  'public', 'admin_preview_schedule_block_conflicts', '{date,time,time}'::name[],
  'anon', '{}'::name[], 'anon: не может вызывать admin_preview_schedule_block_conflicts()'
);

-- ---------------------------------------------------------------------
-- 2. GRANT: appointments/services сужены (Этап 4).
-- ---------------------------------------------------------------------

select table_privs_are(
  'public', 'appointments', 'authenticated', '{SELECT}'::name[],
  'authenticated: только SELECT на appointments (широкий UPDATE отозван — Этап 4)'
);
select table_privs_are(
  'public', 'services', 'authenticated', '{SELECT,INSERT,UPDATE}'::name[],
  'authenticated: SELECT/INSERT/UPDATE на services, БЕЗ DELETE (Этап 4)'
);

-- ---------------------------------------------------------------------
-- 3. admin_change_appointment_status: функциональные сценарии.
-- ---------------------------------------------------------------------

set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-000000000102'; -- не админ

select throws_ok(
  $$select public.admin_change_appointment_status('00000000-0000-0000-0000-0000000000c3', 'completed', null)$$,
  '42501', 'NOT_ADMIN',
  'не-администратор: admin_change_appointment_status() отклоняется (NOT_ADMIN)'
);

reset role;
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-000000000101'; -- админ

select throws_ok(
  $$update public.appointments set status = 'no_show' where id = '00000000-0000-0000-0000-0000000000c3'$$,
  '42501', null,
  'администратор: прямой UPDATE appointments запрещён (нет GRANT, Этап 4)'
);

select is(
  (select status from public.admin_change_appointment_status(
    '00000000-0000-0000-0000-0000000000c3', 'completed', null
  )),
  'completed',
  'администратор: confirmed -> completed через RPC проходит'
);

select throws_ok(
  $$select public.admin_change_appointment_status('00000000-0000-0000-0000-0000000000c3', 'cancelled', null)$$,
  'PB014', 'INVALID_STATUS_TRANSITION',
  'администратор: completed -> cancelled отклоняется (нет обратных переходов)'
);

select throws_ok(
  $$select public.admin_change_appointment_status(gen_random_uuid(), 'completed', null)$$,
  'PB009', 'APPOINTMENT_NOT_FOUND',
  'администратор: несуществующая запись -> APPOINTMENT_NOT_FOUND'
);

-- c4 (заведена в начальном setup) используется для проверки отмены
-- (cancelled_at/cancel_reason).
select is(
  (select status from public.admin_change_appointment_status(
    '00000000-0000-0000-0000-0000000000c4', 'cancelled', 'администратор отменил'
  )),
  'cancelled',
  'администратор: confirmed -> cancelled через RPC проходит'
);
select isnt(
  (select cancelled_at from public.appointments where id = '00000000-0000-0000-0000-0000000000c4'),
  null,
  'отмена через RPC заполняет cancelled_at'
);
select is(
  (select cancel_reason from public.appointments where id = '00000000-0000-0000-0000-0000000000c4'),
  'администратор отменил',
  'отмена через RPC сохраняет cancel_reason'
);

-- ---------------------------------------------------------------------
-- 4. Услуги: физическое удаление невозможно даже администратору.
-- ---------------------------------------------------------------------

select throws_ok(
  $$delete from public.services where id = '00000000-0000-0000-0000-0000000000c1'$$,
  '42501', null,
  'администратор: DELETE на services запрещён даже ему (Этап 4 — нет физического удаления)'
);
select lives_ok(
  $$update public.services set is_active = false where id = '00000000-0000-0000-0000-0000000000c1'$$,
  'администратор: деактивация услуги (UPDATE is_active) по-прежнему разрешена'
);

reset role;

-- ---------------------------------------------------------------------
-- 5. working_hours_no_overlap_active: пересечение активных интервалов
--    запрещено, соседние интервалы и пересечение с неактивным — разрешены.
-- ---------------------------------------------------------------------

select lives_ok(
  $$insert into public.working_hours (weekday, start_time, end_time, is_active) values (0, '09:00', '13:00', true)$$,
  'первый активный интервал понедельника создаётся'
);
select lives_ok(
  $$insert into public.working_hours (weekday, start_time, end_time, is_active) values (0, '13:00', '18:00', true)$$,
  'соседний (не пересекающийся) активный интервал того же дня разрешён'
);
select throws_ok(
  $$insert into public.working_hours (weekday, start_time, end_time, is_active) values (0, '12:00', '14:00', true)$$,
  '23P01', null,
  'пересекающийся активный интервал того же дня отклоняется exclusion constraint'
);
select lives_ok(
  $$insert into public.working_hours (weekday, start_time, end_time, is_active) values (0, '12:00', '14:00', false)$$,
  'пересекающийся, но НЕактивный интервал разрешён (constraint условен по is_active)'
);
select lives_ok(
  $$insert into public.working_hours (weekday, start_time, end_time, is_active) values (1, '09:00', '13:00', true)$$,
  'пересекающееся по времени, но другого дня недели — разрешено'
);

-- ---------------------------------------------------------------------
-- 6. business_settings: CHECK-валидация timezone/business_name.
-- ---------------------------------------------------------------------

select throws_ok(
  $$update public.business_settings set timezone = 'Not/AZone' where id = 1$$,
  '23514', null,
  'невалидный IANA timezone отклоняется CHECK-ограничением'
);
select throws_ok(
  $$update public.business_settings set business_name = '   ' where id = 1$$,
  '23514', null,
  'пустое (из пробелов) business_name отклоняется CHECK-ограничением'
);
select lives_ok(
  $$update public.business_settings set timezone = 'Asia/Tbilisi' where id = 1$$,
  'смена на другой настоящий IANA timezone проходит'
);

-- ---------------------------------------------------------------------
-- 7. admin_create_schedule_block / admin_preview_schedule_block_conflicts:
--    локальное время преобразуется через business_settings.timezone.
-- ---------------------------------------------------------------------

update public.business_settings set timezone = 'Europe/Moscow' where id = 1;

set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-000000000101';

select throws_ok(
  $$select public.admin_create_schedule_block(current_date + 10, '16:00', '14:00', null)$$,
  'PB015', 'INVALID_BLOCK_RANGE',
  'admin_create_schedule_block: окончание раньше начала отклоняется'
);

select is(
  (
    select extract(hour from (starts_at at time zone 'Europe/Moscow'))::int
    from public.admin_create_schedule_block(current_date + 10, '14:00', '16:00', 'тест')
  ),
  14,
  'admin_create_schedule_block: локальное время 14:00 Europe/Moscow сохраняется корректно (round-trip)'
);

-- c5 (заведена в начальном setup, статус не менялся — остаётся
-- 'confirmed') — единственная, которая должна считаться конфликтом для
-- предпросмотра ниже.
select is(
  exists (
    select 1
    from public.admin_preview_schedule_block_conflicts(
      (now() at time zone 'Europe/Moscow')::date + 2, '00:00', '23:59'
    )
    where appointment_id = '00000000-0000-0000-0000-0000000000c3'
  ),
  false,
  'admin_preview_schedule_block_conflicts: завершённая (не confirmed) запись не считается конфликтом'
);
select is(
  exists (
    select 1
    from public.admin_preview_schedule_block_conflicts(
      (now() at time zone 'Europe/Moscow')::date + 3, '00:00', '23:59'
    )
    where appointment_id = '00000000-0000-0000-0000-0000000000c4'
  ),
  false,
  'admin_preview_schedule_block_conflicts: отменённая запись не считается конфликтом'
);
select is(
  exists (
    select 1
    from public.admin_preview_schedule_block_conflicts(
      (now() at time zone 'Europe/Moscow')::date + 4, '00:00', '23:59'
    )
    where appointment_id = '00000000-0000-0000-0000-0000000000c5'
  ),
  true,
  'admin_preview_schedule_block_conflicts: подтверждённая будущая запись считается конфликтом'
);

reset role;

select * from finish();
rollback;
