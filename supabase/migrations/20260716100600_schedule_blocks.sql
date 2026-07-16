-- Разовые периоды недоступности: отпуск, выходной, технический перерыв
-- и т.д. Закрытие полного дня оформляется блоком на весь рабочий период
-- этого дня — отдельного флага "закрытый день" не требуется.

create table public.schedule_blocks (
  id uuid primary key default gen_random_uuid(),
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint schedule_blocks_ends_after_starts check (ends_at > starts_at)
);

create index schedule_blocks_starts_at_idx on public.schedule_blocks (starts_at);
create index schedule_blocks_ends_at_idx on public.schedule_blocks (ends_at);

create trigger set_updated_at
  before update on public.schedule_blocks
  for each row execute function public.set_updated_at();

alter table public.schedule_blocks enable row level security;
alter table public.schedule_blocks force row level security;

revoke all on table public.schedule_blocks from anon, authenticated;

grant select, insert, update, delete on table public.schedule_blocks to authenticated;
grant select on table public.schedule_blocks to service_role;

create policy schedule_blocks_admin_all
  on public.schedule_blocks
  for all
  to authenticated
  using (public.is_admin())
  with check (public.is_admin());
