-- Корректирующая миграция (аудит CI, реальный прогон "supabase test db"
-- на настоящем локальном Supabase-стеке). permissions.test.sql уже
-- ожидал для service_role строго определённый, минимальный набор
-- табличных привилегий (тот же список, что и в исходных миграциях
-- Этапа 1 ниже) — и на bare PostgreSQL (scripts/sql/local_bootstrap.sql,
-- где service_role создаётся "с нуля" без каких-либо привилегий) тест
-- проходил ровно поэтому: там у service_role есть только то, что мы сами
-- явно выдали через GRANT.
--
-- На настоящем Supabase-стеке service_role — не пустая роль: у него
-- изначально (ещё до наших миграций) есть широкие привилегии на все
-- таблицы схемы public, включая REFERENCES/TRIGGER/TRUNCATE — так же,
-- как это уже было учтено для admin_users и (отдельной корректирующей
-- миграцией 20260716140000) для processed_telegram_updates: там REVOKE
-- ALL FROM service_role уже выполнялся явно, поэтому те две таблицы
-- проходили тест и на реальном стеке. Восемь таблиц ниже этот явный
-- REVOKE ALL для service_role раньше пропустили — REVOKE ALL FROM
-- anon, authenticated в их исходных миграциях не затрагивает
-- service_role, и лишние привилегии (REFERENCES/TRIGGER/TRUNCATE)
-- молча оставались.
--
-- Это не ослабление, а обратное: service_role обходит RLS (bypassrls) и
-- поэтому НЕ нуждается ни в TRUNCATE, ни в REFERENCES, ни в TRIGGER ни на
-- одной из таблиц приложения — минимальный набор ниже точно совпадает с
-- тем, что реально использует код бота/панели (см. supabase/tests/
-- permissions.test.sql, разделы про service_role, и
-- README.md, таблицу GRANT). Сами SECURITY DEFINER функции (reserve_
-- appointment, admin_* и т.д.) выполняются от имени владельца функции, а
-- не от service_role, поэтому на их работу это не влияет.

revoke all on table public.business_settings from service_role;
grant select on table public.business_settings to service_role;

revoke all on table public.services from service_role;
grant select on table public.services to service_role;

revoke all on table public.working_hours from service_role;
grant select on table public.working_hours to service_role;

revoke all on table public.schedule_blocks from service_role;
grant select on table public.schedule_blocks to service_role;

revoke all on table public.telegram_users from service_role;
grant select, insert, update on table public.telegram_users to service_role;

revoke all on table public.booking_sessions from service_role;
grant select, insert, update, delete on table public.booking_sessions to service_role;

revoke all on table public.appointments from service_role;
grant select, insert, update on table public.appointments to service_role;

revoke all on table public.notification_deliveries from service_role;
grant select, insert, update on table public.notification_deliveries to service_role;
