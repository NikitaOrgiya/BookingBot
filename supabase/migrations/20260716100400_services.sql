-- Каталог услуг.

create table public.services (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  description text,
  duration_minutes integer not null,
  price_cents integer,
  is_active boolean not null default true,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint services_name_not_blank check (btrim(name) <> ''),
  constraint services_duration_range check (duration_minutes between 5 and 480),
  constraint services_price_non_negative
    check (price_cents is null or price_cents >= 0)
);

create index services_is_active_sort_order_idx
  on public.services (is_active, sort_order);

create trigger set_updated_at
  before update on public.services
  for each row execute function public.set_updated_at();

alter table public.services enable row level security;
alter table public.services force row level security;

revoke all on table public.services from anon, authenticated;

grant select, insert, update, delete on table public.services to authenticated;
-- service_role только читает услуги (для расчёта доступных слотов и
-- бронирования), изменяет их исключительно администратор через панель.
grant select on table public.services to service_role;

create policy services_admin_all
  on public.services
  for all
  to authenticated
  using (public.is_admin())
  with check (public.is_admin());
