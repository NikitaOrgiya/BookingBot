-- Связывает пользователя Supabase Auth с правами администратора.
-- Публичной регистрации администратора нет: первая запись создаётся
-- вручную после создания пользователя в Supabase Auth.

create table public.admin_users (
  user_id uuid primary key references auth.users (id) on delete cascade,
  created_at timestamptz not null default now()
);

alter table public.admin_users enable row level security;
-- FORCE здесь намеренно не включаем: public.is_admin() (следующая миграция)
-- выполняется как SECURITY DEFINER от имени владельца таблицы и должен
-- иметь возможность читать её без ограничений RLS.

-- Ни anon, ни authenticated, ни service_role не получают прямого доступа
-- к этой таблице. Единственный способ проверить права администратора —
-- вызвать public.is_admin(), которая сама решает, кто admin, не раскрывая
-- содержимое таблицы вызывающей роли.
revoke all on table public.admin_users from anon, authenticated, service_role;
