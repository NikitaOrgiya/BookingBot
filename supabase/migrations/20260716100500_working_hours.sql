-- Регулярное недельное расписание. 0 = понедельник, 6 = воскресенье.
-- В один день допускается несколько интервалов (например, с перерывом
-- на обед), поэтому отдельной сущности "обед" не требуется.

create table public.working_hours (
  id uuid primary key default gen_random_uuid(),
  weekday smallint not null,
  start_time time not null,
  end_time time not null,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint working_hours_weekday_range check (weekday between 0 and 6),
  constraint working_hours_end_after_start check (end_time > start_time)
);

create index working_hours_weekday_idx on public.working_hours (weekday);

create trigger set_updated_at
  before update on public.working_hours
  for each row execute function public.set_updated_at();

alter table public.working_hours enable row level security;
alter table public.working_hours force row level security;

revoke all on table public.working_hours from anon, authenticated;

grant select, insert, update, delete on table public.working_hours to authenticated;
grant select on table public.working_hours to service_role;

create policy working_hours_admin_all
  on public.working_hours
  for all
  to authenticated
  using (public.is_admin())
  with check (public.is_admin());
