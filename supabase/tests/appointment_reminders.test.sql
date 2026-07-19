-- pgTAP-тесты для Этапа 5 (автоматические Telegram-напоминания):
--   public.appointment_reminders (новая отдельная таблица — НЕ переименование
--     public.notification_deliveries, которая осталась нетронутой; см.
--     обоснование в supabase/migrations/20260719100000_appointment_reminders.sql)
--   create_appointment_reminders_for_confirmed() — триггер создания
--   skip_appointment_reminders_on_terminal_status() — триггер отмены
--   public.claim_due_appointment_reminders / mark_appointment_reminder_sent /
--     mark_appointment_reminder_failed / mark_appointment_reminder_skipped
--
-- Запуск:
--   pg_prove -d bookingbot_test supabase/tests/appointment_reminders.test.sql
-- Проще всего — через `npm run test:sql`, который гоняет все *.test.sql.
--
-- ВАЖНО про claim_due_appointment_reminders: pgTAP выполняется в ОДНОЙ
-- сессии, поэтому здесь проверяется только логическая корректность (какие
-- строки claim выбирает/не выбирает, что attempt_count растёт, что lease
-- истекает и позволяет перезахват) — НЕ настоящая конкурентная гонка двух
-- параллельных подключений за одну и ту же строку. Та часть проверяется в
-- tests/integration/appointment-reminders.test.ts реальными подключениями
-- pg (тот же принцип разделения, что и у double-booking-race.test.ts для
-- ядра бронирования, см. README).

begin;
select no_plan();

-- ---------------------------------------------------------------------
-- Тестовые данные.
-- ---------------------------------------------------------------------

insert into public.services (id, name, duration_minutes, price_cents, is_active) values
  ('00000000-0000-0000-0000-0000000000d1', 'Тестовая услуга Этапа 5', 60, 200000, true);

insert into public.telegram_users (id, telegram_user_id) values
  ('00000000-0000-0000-0000-0000000000d2', 5001);

update public.business_settings set
  reminder_first_minutes = 1440,
  reminder_second_minutes = 120
where id = 1;

-- Отдельная запись только для проверок CHECK/FK ниже (изолированный
-- временной интервал, не пересекающийся ни с одной другой записью этого
-- файла) — до триггера создания напоминаний ей ещё не время (150+ минут
-- до начала), поэтому автосозданные строки не мешают ручным INSERT'ам
-- в этом разделе.
insert into public.appointments (
  id, telegram_user_id, service_id, service_name_snapshot,
  duration_minutes_snapshot, price_cents_snapshot, start_at, end_at, status
) values (
  '00000000-0000-0000-0000-0000000000d0',
  '00000000-0000-0000-0000-0000000000d2',
  '00000000-0000-0000-0000-0000000000d1',
  'Тестовая услуга Этапа 5', 60, 200000,
  now() + interval '50 minutes', now() + interval '80 minutes',
  'confirmed'
);

-- ---------------------------------------------------------------------
-- 1. Схема: CHECK-ограничения.
-- ---------------------------------------------------------------------

select throws_ok(
  $$insert into public.appointment_reminders (appointment_id, reminder_type, scheduled_for)
    values ('00000000-0000-0000-0000-0000000000d0', 'bogus_type', now())$$,
  '23514', null,
  'reminder_type вне {24h,2h} отклоняется CHECK-ограничением'
);

select throws_ok(
  $$insert into public.appointment_reminders (appointment_id, reminder_type, scheduled_for, status)
    values ('00000000-0000-0000-0000-0000000000d0', '24h', now(), 'bogus_status')$$,
  '23514', null,
  'status вне допустимого набора отклоняется CHECK-ограничением'
);

select throws_ok(
  $$insert into public.appointment_reminders (appointment_id, reminder_type, scheduled_for, status, sent_at)
    values ('00000000-0000-0000-0000-0000000000d0', '24h', now(), 'sent', null)$$,
  '23514', null,
  'status=sent без sent_at отклоняется CHECK-ограничением'
);

select throws_ok(
  $$insert into public.appointment_reminders (appointment_id, reminder_type, scheduled_for, status, sent_at)
    values ('00000000-0000-0000-0000-0000000000d0', '24h', now(), 'pending', now())$$,
  '23514', null,
  'sent_at заполнен при status <> sent отклоняется CHECK-ограничением'
);

select throws_ok(
  format(
    $$insert into public.appointment_reminders (appointment_id, reminder_type, scheduled_for, last_error_message)
      values ('00000000-0000-0000-0000-0000000000d0', '24h', now(), %L)$$,
    repeat('x', 501)
  ),
  '23514', null,
  'last_error_message длиннее 500 символов отклоняется CHECK-ограничением'
);

select lives_ok(
  format(
    $$insert into public.appointment_reminders (appointment_id, reminder_type, scheduled_for, last_error_message)
      values ('00000000-0000-0000-0000-0000000000d0', '2h', now(), %L)$$,
    repeat('x', 500)
  ),
  'last_error_message ровно 500 символов допустим'
);
delete from public.appointment_reminders
 where appointment_id = '00000000-0000-0000-0000-0000000000d0' and reminder_type = '2h';

select throws_ok(
  $$insert into public.appointment_reminders (appointment_id, reminder_type, scheduled_for)
    values ('00000000-0000-0000-0000-000000000fff', '24h', now())$$,
  '23503', null,
  'appointment_id, не существующий в appointments, отклоняется foreign key'
);

-- ---------------------------------------------------------------------
-- 2. GRANT: claim/mark_*-функции доступны только service_role.
-- ---------------------------------------------------------------------

select function_privs_are(
  'public', 'claim_due_appointment_reminders', '{integer}'::name[],
  'anon', '{}'::name[], 'anon: не может вызывать claim_due_appointment_reminders()'
);
select function_privs_are(
  'public', 'claim_due_appointment_reminders', '{integer}'::name[],
  'authenticated', '{}'::name[], 'authenticated: не может вызывать claim_due_appointment_reminders()'
);
select function_privs_are(
  'public', 'claim_due_appointment_reminders', '{integer}'::name[],
  'service_role', '{EXECUTE}'::name[], 'service_role: может вызывать claim_due_appointment_reminders()'
);

select function_privs_are(
  'public', 'mark_appointment_reminder_sent', '{uuid,bigint}'::name[],
  'anon', '{}'::name[], 'anon: не может вызывать mark_appointment_reminder_sent()'
);
select function_privs_are(
  'public', 'mark_appointment_reminder_sent', '{uuid,bigint}'::name[],
  'authenticated', '{}'::name[], 'authenticated: не может вызывать mark_appointment_reminder_sent()'
);
select function_privs_are(
  'public', 'mark_appointment_reminder_sent', '{uuid,bigint}'::name[],
  'service_role', '{EXECUTE}'::name[], 'service_role: может вызывать mark_appointment_reminder_sent()'
);

select function_privs_are(
  'public', 'mark_appointment_reminder_failed', '{uuid,text,text,timestamptz,boolean}'::name[],
  'anon', '{}'::name[], 'anon: не может вызывать mark_appointment_reminder_failed()'
);
select function_privs_are(
  'public', 'mark_appointment_reminder_failed', '{uuid,text,text,timestamptz,boolean}'::name[],
  'authenticated', '{}'::name[], 'authenticated: не может вызывать mark_appointment_reminder_failed()'
);
select function_privs_are(
  'public', 'mark_appointment_reminder_failed', '{uuid,text,text,timestamptz,boolean}'::name[],
  'service_role', '{EXECUTE}'::name[], 'service_role: может вызывать mark_appointment_reminder_failed()'
);

select function_privs_are(
  'public', 'mark_appointment_reminder_skipped', '{uuid,text}'::name[],
  'anon', '{}'::name[], 'anon: не может вызывать mark_appointment_reminder_skipped()'
);
select function_privs_are(
  'public', 'mark_appointment_reminder_skipped', '{uuid,text}'::name[],
  'authenticated', '{}'::name[], 'authenticated: не может вызывать mark_appointment_reminder_skipped()'
);
select function_privs_are(
  'public', 'mark_appointment_reminder_skipped', '{uuid,text}'::name[],
  'service_role', '{EXECUTE}'::name[], 'service_role: может вызывать mark_appointment_reminder_skipped()'
);

-- ---------------------------------------------------------------------
-- 3. Триггер создания: подтверждённая запись с достаточным запасом до
--    начала получает ОБА напоминания (24h и 2h) с правильным scheduled_for.
-- ---------------------------------------------------------------------

insert into public.appointments (
  id, telegram_user_id, service_id, service_name_snapshot,
  duration_minutes_snapshot, price_cents_snapshot, start_at, end_at, status
) values (
  '00000000-0000-0000-0000-0000000000d3',
  '00000000-0000-0000-0000-0000000000d2',
  '00000000-0000-0000-0000-0000000000d1',
  'Тестовая услуга Этапа 5', 60, 200000,
  now() + interval '30 hours', now() + interval '31 hours',
  'confirmed'
);

select is(
  (select count(*)::int from public.appointment_reminders
    where appointment_id = '00000000-0000-0000-0000-0000000000d3'),
  2,
  'подтверждённая запись за 30 часов до начала получает оба напоминания (24h и 2h)'
);

select is(
  (select scheduled_for from public.appointment_reminders
    where appointment_id = '00000000-0000-0000-0000-0000000000d3' and reminder_type = '24h'),
  (select start_at - interval '1440 minutes' from public.appointments
    where id = '00000000-0000-0000-0000-0000000000d3'),
  '24h scheduled_for = start_at - reminder_first_minutes'
);
select is(
  (select scheduled_for from public.appointment_reminders
    where appointment_id = '00000000-0000-0000-0000-0000000000d3' and reminder_type = '2h'),
  (select start_at - interval '120 minutes' from public.appointments
    where id = '00000000-0000-0000-0000-0000000000d3'),
  '2h scheduled_for = start_at - reminder_second_minutes'
);
select is(
  (select status from public.appointment_reminders
    where appointment_id = '00000000-0000-0000-0000-0000000000d3' and reminder_type = '24h'),
  'pending',
  'новое напоминание создаётся в статусе pending'
);

-- Регрессионная проверка: next_attempt_at ДОЛЖЕН быть равен scheduled_for
-- при создании, а не column default now() — иначе claim_due_appointment_reminders
-- (проверяющая именно next_attempt_at, а не scheduled_for, у pending-строк)
-- забрала бы совершенно свежую запись за 30 часов до начала немедленно,
-- проигнорировав, что до неё ещё далеко.
select is(
  (select next_attempt_at from public.appointment_reminders
    where appointment_id = '00000000-0000-0000-0000-0000000000d3' and reminder_type = '24h'),
  (select scheduled_for from public.appointment_reminders
    where appointment_id = '00000000-0000-0000-0000-0000000000d3' and reminder_type = '24h'),
  'next_attempt_at выставлен равным scheduled_for при создании, а не now()'
);
set role service_role;
select is(
  (select count(*)::int from public.claim_due_appointment_reminders(50)
    where appointment_id = '00000000-0000-0000-0000-0000000000d3'),
  0,
  'свежесозданное напоминание за 30 часов до начала НЕ является due прямо сейчас'
);
reset role;

-- Повторный UPDATE ... SET status = 'confirmed' на уже confirmed-записи
-- не создаёт дублей (unique constraint + защитная проверка в триггере).
update public.appointments set client_note = 'noop'
 where id = '00000000-0000-0000-0000-0000000000d3';
select is(
  (select count(*)::int from public.appointment_reminders
    where appointment_id = '00000000-0000-0000-0000-0000000000d3'),
  2,
  'обновление записи, не меняющее статус, не создаёт лишних напоминаний'
);

-- ---------------------------------------------------------------------
-- 4. Триггер создания: запись, созданная слишком близко к своему началу,
--    не получает соответствующий тип напоминания (или не получает вообще
--    ни одного), но НЕ падает с ошибкой.
-- ---------------------------------------------------------------------

-- 90 минут до начала: 24h-before уже в прошлом, 2h-before (120 минут) —
-- тоже в прошлом (90 < 120) => ни одно напоминание не создаётся.
insert into public.appointments (
  id, telegram_user_id, service_id, service_name_snapshot,
  duration_minutes_snapshot, price_cents_snapshot, start_at, end_at, status
) values (
  '00000000-0000-0000-0000-0000000000d4',
  '00000000-0000-0000-0000-0000000000d2',
  '00000000-0000-0000-0000-0000000000d1',
  'Тестовая услуга Этапа 5', 60, 200000,
  now() + interval '90 minutes', now() + interval '150 minutes',
  'confirmed'
);
select is(
  (select count(*)::int from public.appointment_reminders
    where appointment_id = '00000000-0000-0000-0000-0000000000d4'),
  0,
  'запись за 90 минут до начала не получает ни 24h, ни 2h напоминание'
);

-- 3 часа до начала: 24h-before в прошлом (пропускается), 2h-before
-- (за 1 час от текущего момента) — ещё в будущем => получает только 2h.
insert into public.appointments (
  id, telegram_user_id, service_id, service_name_snapshot,
  duration_minutes_snapshot, price_cents_snapshot, start_at, end_at, status
) values (
  '00000000-0000-0000-0000-0000000000d5',
  '00000000-0000-0000-0000-0000000000d2',
  '00000000-0000-0000-0000-0000000000d1',
  'Тестовая услуга Этапа 5', 60, 200000,
  now() + interval '3 hours', now() + interval '4 hours',
  'confirmed'
);
select is(
  (select count(*)::int from public.appointment_reminders
    where appointment_id = '00000000-0000-0000-0000-0000000000d5'),
  1,
  'запись за 3 часа до начала получает ровно одно напоминание'
);
select is(
  (select reminder_type from public.appointment_reminders
    where appointment_id = '00000000-0000-0000-0000-0000000000d5'),
  '2h',
  'запись за 3 часа до начала получает именно 2h, а не 24h'
);

-- ---------------------------------------------------------------------
-- 5. Триггер создания: тип напоминания, отключённый в business_settings
--    (NULL), не создаётся вообще, даже если запись далеко в будущем.
-- ---------------------------------------------------------------------

update public.business_settings set reminder_first_minutes = null where id = 1;

insert into public.appointments (
  id, telegram_user_id, service_id, service_name_snapshot,
  duration_minutes_snapshot, price_cents_snapshot, start_at, end_at, status
) values (
  '00000000-0000-0000-0000-0000000000d6',
  '00000000-0000-0000-0000-0000000000d2',
  '00000000-0000-0000-0000-0000000000d1',
  'Тестовая услуга Этапа 5', 60, 200000,
  now() + interval '10 days', now() + interval '10 days 1 hour',
  'confirmed'
);
select is(
  (select count(*)::int from public.appointment_reminders
    where appointment_id = '00000000-0000-0000-0000-0000000000d6'),
  1,
  'при reminder_first_minutes = NULL создаётся только 2h-напоминание'
);
select is(
  (select reminder_type from public.appointment_reminders
    where appointment_id = '00000000-0000-0000-0000-0000000000d6'),
  '2h',
  'единственное созданное напоминание — именно 2h'
);

update public.business_settings set reminder_first_minutes = 1440 where id = 1;

-- ---------------------------------------------------------------------
-- 6. Триггер отмены: cancelled/completed переводят pending-напоминания в
--    skipped, но не трогают уже sent/processing.
-- ---------------------------------------------------------------------

update public.appointments set status = 'cancelled', cancelled_at = now()
 where id = '00000000-0000-0000-0000-0000000000d3';

select is(
  (select array_agg(status order by reminder_type)
     from public.appointment_reminders
    where appointment_id = '00000000-0000-0000-0000-0000000000d3'),
  array['skipped', 'skipped'],
  'отмена подтверждённой записи переводит её pending-напоминания в skipped'
);

-- processing-строка не трогается триггером отмены (это забота worker-а
-- через mark_appointment_reminder_skipped при пред-отправочной проверке).
update public.appointment_reminders set status = 'processing', locked_at = now()
 where appointment_id = '00000000-0000-0000-0000-0000000000d5' and reminder_type = '2h';
update public.appointments set status = 'completed'
 where id = '00000000-0000-0000-0000-0000000000d5';
select is(
  (select status from public.appointment_reminders
    where appointment_id = '00000000-0000-0000-0000-0000000000d5' and reminder_type = '2h'),
  'processing',
  'processing-напоминание НЕ переводится в skipped триггером отмены (это делает worker через mark_..._skipped)'
);

-- ---------------------------------------------------------------------
-- 7. claim_due_appointment_reminders: due-строка захватывается, статус ->
--    processing, attempt_count растёт, locked_at выставляется.
-- ---------------------------------------------------------------------

insert into public.appointments (
  id, telegram_user_id, service_id, service_name_snapshot,
  duration_minutes_snapshot, price_cents_snapshot, start_at, end_at, status
) values (
  '00000000-0000-0000-0000-0000000000d7',
  '00000000-0000-0000-0000-0000000000d2',
  '00000000-0000-0000-0000-0000000000d1',
  'Тестовая услуга Этапа 5', 60, 200000,
  now() + interval '5 hours', now() + interval '6 hours',
  'confirmed'
);
-- Форсируем scheduled_for/next_attempt_at в прошлое, чтобы строка стала due
-- прямо сейчас (не дожидаясь реального наступления времени напоминания).
update public.appointment_reminders
   set scheduled_for = now() - interval '1 minute',
       next_attempt_at = now() - interval '1 minute'
 where appointment_id = '00000000-0000-0000-0000-0000000000d7' and reminder_type = '2h';

set role service_role;

select is(
  (select count(*)::int from public.claim_due_appointment_reminders(50)
    where appointment_id = '00000000-0000-0000-0000-0000000000d7'),
  1,
  'due-напоминание захватывается claim_due_appointment_reminders'
);

select is(
  (select status from public.appointment_reminders
    where appointment_id = '00000000-0000-0000-0000-0000000000d7' and reminder_type = '2h'),
  'processing',
  'claim переводит захваченную строку в processing'
);
select is(
  (select attempt_count from public.appointment_reminders
    where appointment_id = '00000000-0000-0000-0000-0000000000d7' and reminder_type = '2h'),
  1,
  'claim увеличивает attempt_count'
);
select isnt(
  (select locked_at from public.appointment_reminders
    where appointment_id = '00000000-0000-0000-0000-0000000000d7' and reminder_type = '2h'),
  null,
  'claim выставляет locked_at'
);

-- Повторный claim НЕ возвращает ту же строку — lease ещё не истёк.
select is(
  (select count(*)::int from public.claim_due_appointment_reminders(50)
    where appointment_id = '00000000-0000-0000-0000-0000000000d7'),
  0,
  'повторный claim не забирает ещё не истёкший (processing) lease'
);

-- ---------------------------------------------------------------------
-- 8. mark_appointment_reminder_sent / failed / skipped.
-- ---------------------------------------------------------------------

select is(
  (select public.mark_appointment_reminder_sent(
    (select id from public.appointment_reminders
      where appointment_id = '00000000-0000-0000-0000-0000000000d7' and reminder_type = '2h'),
    123456
  )),
  true,
  'mark_appointment_reminder_sent успешно завершает processing-строку'
);
select is(
  (select status from public.appointment_reminders
    where appointment_id = '00000000-0000-0000-0000-0000000000d7' and reminder_type = '2h'),
  'sent',
  'после mark_sent статус — sent'
);
select isnt(
  (select sent_at from public.appointment_reminders
    where appointment_id = '00000000-0000-0000-0000-0000000000d7' and reminder_type = '2h'),
  null,
  'после mark_sent sent_at заполнен'
);
select is(
  (select telegram_message_id from public.appointment_reminders
    where appointment_id = '00000000-0000-0000-0000-0000000000d7' and reminder_type = '2h'),
  123456::bigint,
  'после mark_sent telegram_message_id сохранён'
);

-- Повторный mark_sent на уже sent-строке — не находит processing-строку,
-- возвращает false, не бросает исключение.
select is(
  (select public.mark_appointment_reminder_sent(
    (select id from public.appointment_reminders
      where appointment_id = '00000000-0000-0000-0000-0000000000d7' and reminder_type = '2h'),
    999
  )),
  false,
  'повторный mark_sent на уже sent-строке — идемпотентно false, не ошибка'
);

-- mark_failed: не терминальная неудача -> pending + next_attempt_at.
insert into public.appointments (
  id, telegram_user_id, service_id, service_name_snapshot,
  duration_minutes_snapshot, price_cents_snapshot, start_at, end_at, status
) values (
  '00000000-0000-0000-0000-0000000000d8',
  '00000000-0000-0000-0000-0000000000d2',
  '00000000-0000-0000-0000-0000000000d1',
  'Тестовая услуга Этапа 5', 60, 200000,
  now() + interval '7 hours', now() + interval '8 hours',
  'confirmed'
);
update public.appointment_reminders
   set scheduled_for = now() - interval '1 minute',
       next_attempt_at = now() - interval '1 minute'
 where appointment_id = '00000000-0000-0000-0000-0000000000d8' and reminder_type = '2h';
select * from public.claim_due_appointment_reminders(50);

select is(
  (select public.mark_appointment_reminder_failed(
    (select id from public.appointment_reminders
      where appointment_id = '00000000-0000-0000-0000-0000000000d8' and reminder_type = '2h'),
    'TELEGRAM_500', 'Telegram API 500: Internal Server Error',
    now() + interval '5 minutes', false
  )),
  true,
  'mark_appointment_reminder_failed (не терминально) переводит строку в pending'
);
select is(
  (select status from public.appointment_reminders
    where appointment_id = '00000000-0000-0000-0000-0000000000d8' and reminder_type = '2h'),
  'pending',
  'после нетерминального mark_failed статус — pending (будет повтор)'
);
select ok(
  (select next_attempt_at > now() from public.appointment_reminders
    where appointment_id = '00000000-0000-0000-0000-0000000000d8' and reminder_type = '2h'),
  'после нетерминального mark_failed next_attempt_at выставлен в будущее'
);
select is(
  (select last_error_code from public.appointment_reminders
    where appointment_id = '00000000-0000-0000-0000-0000000000d8' and reminder_type = '2h'),
  'TELEGRAM_500',
  'last_error_code сохранён'
);

-- mark_failed терминально -> failed, next_attempt_at не трогается.
-- Строка сейчас pending с будущим next_attempt_at (не due для настоящего
-- claim) — переводим её в processing вручную, имитируя очередной цикл
-- claim/mark_failed без ожидания реального наступления next_attempt_at.
update public.appointment_reminders
   set status = 'processing', locked_at = now()
 where appointment_id = '00000000-0000-0000-0000-0000000000d8' and reminder_type = '2h';
select is(
  (select public.mark_appointment_reminder_failed(
    (select id from public.appointment_reminders
      where appointment_id = '00000000-0000-0000-0000-0000000000d8' and reminder_type = '2h'),
    'TELEGRAM_403', 'Telegram API 403: Forbidden: bot was blocked by the user',
    null, true
  )),
  true,
  'mark_appointment_reminder_failed (терминально) успешно завершает processing-строку'
);
select is(
  (select status from public.appointment_reminders
    where appointment_id = '00000000-0000-0000-0000-0000000000d8' and reminder_type = '2h'),
  'failed',
  'после терминального mark_failed статус — failed (retry прекращён)'
);

-- mark_skipped: пред-отправочная проверка обнаружила, что запись больше не
-- подходит для отправки (отменена/началась между claim и отправкой).
insert into public.appointments (
  id, telegram_user_id, service_id, service_name_snapshot,
  duration_minutes_snapshot, price_cents_snapshot, start_at, end_at, status
) values (
  '00000000-0000-0000-0000-0000000000d9',
  '00000000-0000-0000-0000-0000000000d2',
  '00000000-0000-0000-0000-0000000000d1',
  'Тестовая услуга Этапа 5', 60, 200000,
  now() + interval '9 hours', now() + interval '10 hours',
  'confirmed'
);
update public.appointment_reminders
   set status = 'processing', locked_at = now()
 where appointment_id = '00000000-0000-0000-0000-0000000000d9' and reminder_type = '2h';
select is(
  (select public.mark_appointment_reminder_skipped(
    (select id from public.appointment_reminders
      where appointment_id = '00000000-0000-0000-0000-0000000000d9' and reminder_type = '2h'),
    'APPOINTMENT_NO_LONGER_ELIGIBLE'
  )),
  true,
  'mark_appointment_reminder_skipped успешно завершает processing-строку'
);
select is(
  (select status from public.appointment_reminders
    where appointment_id = '00000000-0000-0000-0000-0000000000d9' and reminder_type = '2h'),
  'skipped',
  'после mark_skipped статус — skipped'
);

-- ---------------------------------------------------------------------
-- 9. claim не выдаёт напоминания для НЕ-confirmed или уже начавшихся
--    записей, даже если сама строка формально pending/due.
-- ---------------------------------------------------------------------

-- Уже начавшаяся (прошедшая) запись создаётся сразу с интервалом в
-- прошлом — не через UPDATE уже существующей будущей записи: UPDATE
-- start_at при неизменном end_at растянул бы интервал так, что он
-- пересёкся бы с другими confirmed-записями фикстур этого файла и упал бы
-- на exclusion constraint. Триггер создания при этом INSERT не заводит ни
-- одного напоминания сам (scheduled_for был бы ещё дальше в прошлом) —
-- нужная "формально ещё pending" строка ниже вставляется отдельно и
-- напрямую, в обход триггера.
insert into public.appointments (
  id, telegram_user_id, service_id, service_name_snapshot,
  duration_minutes_snapshot, price_cents_snapshot, start_at, end_at, status
) values (
  '00000000-0000-0000-0000-0000000000da',
  '00000000-0000-0000-0000-0000000000d2',
  '00000000-0000-0000-0000-0000000000d1',
  'Тестовая услуга Этапа 5', 60, 200000,
  now() - interval '2 hours', now() - interval '1 hour',
  'confirmed'
);
insert into public.appointment_reminders (appointment_id, reminder_type, scheduled_for, next_attempt_at)
values ('00000000-0000-0000-0000-0000000000da', '24h', now() - interval '1 minute', now() - interval '1 minute');

select is(
  (select count(*)::int from public.claim_due_appointment_reminders(50)
    where appointment_id = '00000000-0000-0000-0000-0000000000da'),
  0,
  'claim не выдаёт напоминание для уже начавшейся записи (start_at <= now())'
);

reset role;

select * from finish();
rollback;
