-- Журнал напоминаний. Уникальность (appointment_id, notification_type)
-- не позволяет отправить одинаковое напоминание дважды даже при повторном
-- запуске cron.

create table public.notification_deliveries (
  id uuid primary key default gen_random_uuid(),
  appointment_id uuid not null references public.appointments (id),
  notification_type text not null,
  status text not null default 'pending',
  attempts integer not null default 0,
  last_error text,
  scheduled_for timestamptz not null,
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint notification_deliveries_type_allowed
    check (notification_type in ('reminder_first', 'reminder_second')),
  constraint notification_deliveries_status_allowed
    check (status in ('pending', 'processing', 'sent', 'failed')),
  constraint notification_deliveries_attempts_non_negative
    check (attempts >= 0),
  constraint notification_deliveries_unique_per_appointment
    unique (appointment_id, notification_type)
);

create index notification_deliveries_scheduled_for_idx
  on public.notification_deliveries (scheduled_for);
create index notification_deliveries_status_idx
  on public.notification_deliveries (status);

create trigger set_updated_at
  before update on public.notification_deliveries
  for each row execute function public.set_updated_at();

alter table public.notification_deliveries enable row level security;
alter table public.notification_deliveries force row level security;

revoke all on table public.notification_deliveries from anon, authenticated;

-- Администратор только просматривает журнал напоминаний.
grant select on table public.notification_deliveries to authenticated;
-- Cron-задача пишет и обновляет статусы попыток отправки.
grant select, insert, update on table public.notification_deliveries to service_role;

create policy notification_deliveries_admin_select
  on public.notification_deliveries
  for select
  to authenticated
  using (public.is_admin());
