-- Только для локального тестирования миграций и RLS-политик на обычном
-- PostgreSQL, без настоящего Supabase-проекта. Реальный Supabase-проект
-- уже предоставляет роли anon/authenticated/service_role и схему auth
-- "из коробки" — в production-миграциях (supabase/migrations) они не
-- создаются и создавать их там нельзя.
--
-- Намеренно лежит вне supabase/tests/: `supabase test db` прогоняет
-- через pg_prove каждый *.sql файл из этой директории как отдельный
-- TAP-тест, а этот файл — не тест и не содержит TAP-плана (что и
-- ломало supabase-db-reset job: "Parse errors: No plan found in TAP
-- output", плюс "permission denied for schema auth" — в настоящем
-- Supabase-стеке схема auth уже существует и не принадлежит роли
-- postgres). Используется только через scripts/test-sql.sh
-- (bare-PostgreSQL проверка), не через Supabase CLI.
--
-- Использование:
--   createdb bookingbot_test
--   psql bookingbot_test -f scripts/sql/local_bootstrap.sql
--   for f in supabase/migrations/*.sql; do psql bookingbot_test -f "$f"; done
--   psql bookingbot_test -f supabase/seed.sql

create schema if not exists auth;

create table if not exists auth.users (
  id uuid primary key default gen_random_uuid()
);

-- Повторяет поведение настоящего auth.uid() в Supabase: значение берётся
-- из claim "sub" JWT текущего запроса, которое PostgREST кладёт в
-- параметр сессии request.jwt.claim.sub.
create or replace function auth.uid()
returns uuid
language sql
stable
as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid;
$$;

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    -- В настоящем Supabase service_role имеет атрибут bypassrls — RLS для
    -- неё не действует независимо от FORCE ROW LEVEL SECURITY, но обычные
    -- права GRANT ей всё равно нужны (см. README, раздел про RLS и GRANT).
    create role service_role nologin noinherit bypassrls;
  end if;
end;
$$;

grant usage on schema public to anon, authenticated, service_role;
grant usage on schema auth to anon, authenticated, service_role;
