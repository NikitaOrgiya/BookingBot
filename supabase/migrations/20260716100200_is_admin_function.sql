-- Проверяет, состоит ли текущий пользователь (auth.uid()) в admin_users.
-- SECURITY DEFINER с фиксированным search_path и полными именами таблиц —
-- чтобы вызывающая роль не могла подменить public.admin_users через свой
-- собственный search_path.

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.admin_users as au
    where au.user_id = auth.uid()
  );
$$;

revoke all on function public.is_admin() from public;
-- Функцию вызывает только административная веб-панель (роль authenticated).
-- service_role обходит RLS напрямую и не нуждается в этой проверке.
grant execute on function public.is_admin() to authenticated;
