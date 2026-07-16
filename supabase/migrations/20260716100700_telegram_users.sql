-- Клиенты, взаимодействовавшие с ботом. Профиль обновляется при каждом
-- взаимодействии. Телефон в первой версии необязателен.

create table public.telegram_users (
  id uuid primary key default gen_random_uuid(),
  telegram_user_id bigint not null unique,
  username text,
  first_name text,
  last_name text,
  phone text,
  language_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger set_updated_at
  before update on public.telegram_users
  for each row execute function public.set_updated_at();

alter table public.telegram_users enable row level security;
alter table public.telegram_users force row level security;

revoke all on table public.telegram_users from anon, authenticated;

-- Администратор только просматривает контакты клиентов в панели.
grant select on table public.telegram_users to authenticated;
-- Бот регистрирует/обновляет профиль при каждом обращении (upsert).
grant select, insert, update on table public.telegram_users to service_role;

create policy telegram_users_admin_select
  on public.telegram_users
  for select
  to authenticated
  using (public.is_admin());
