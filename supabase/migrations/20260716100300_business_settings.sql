-- Единственная строка с настройками организации.

create table public.business_settings (
  id smallint primary key default 1,
  business_name text not null,
  timezone text not null,
  booking_horizon_days integer not null,
  min_booking_notice_minutes integer not null,
  cancellation_notice_minutes integer not null,
  reminder_first_minutes integer,
  reminder_second_minutes integer,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint business_settings_single_row check (id = 1),
  constraint business_settings_horizon_range
    check (booking_horizon_days between 1 and 180),
  constraint business_settings_min_notice_non_negative
    check (min_booking_notice_minutes >= 0),
  constraint business_settings_cancellation_notice_non_negative
    check (cancellation_notice_minutes >= 0)
);

create trigger set_updated_at
  before update on public.business_settings
  for each row execute function public.set_updated_at();

alter table public.business_settings enable row level security;
alter table public.business_settings force row level security;

revoke all on table public.business_settings from anon, authenticated;

grant select, update on table public.business_settings to authenticated;
grant select on table public.business_settings to service_role;

create policy business_settings_admin_select
  on public.business_settings
  for select
  to authenticated
  using (public.is_admin());

create policy business_settings_admin_update
  on public.business_settings
  for update
  to authenticated
  using (public.is_admin())
  with check (public.is_admin());
