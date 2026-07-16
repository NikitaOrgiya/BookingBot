-- Основная таблица записей. Название, длительность и цена услуги
-- сохраняются в snapshot-полях: изменение услуги в справочнике не должно
-- менять уже существующие записи.
--
-- Защита от двойного бронирования реализована на уровне PostgreSQL через
-- exclusion constraint, а не только проверкой в интерфейсе: между показом
-- свободного слота и нажатием кнопки подтверждения другой клиент может
-- успеть занять это же время, поэтому окончательное решение всегда
-- принимает база данных в момент вставки записи.

create table public.appointments (
  id uuid primary key default gen_random_uuid(),
  telegram_user_id uuid not null references public.telegram_users (id),
  service_id uuid not null references public.services (id),
  service_name_snapshot text not null,
  duration_minutes_snapshot integer not null,
  price_cents_snapshot integer,
  start_at timestamptz not null,
  end_at timestamptz not null,
  status text not null default 'confirmed',
  client_note text,
  cancelled_at timestamptz,
  cancel_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint appointments_end_after_start check (end_at > start_at),
  constraint appointments_status_allowed
    check (status in ('confirmed', 'completed', 'cancelled', 'no_show')),
  constraint appointments_duration_positive
    check (duration_minutes_snapshot > 0),
  constraint appointments_price_non_negative
    check (price_cents_snapshot is null or price_cents_snapshot >= 0),
  -- Два активных (confirmed/completed/no_show) интервала времени не могут
  -- пересекаться. Отменённые записи (cancelled) исключены из проверки —
  -- отмена сразу освобождает время.
  exclude using gist (
    tstzrange(start_at, end_at, '[)') with &&
  ) where (status in ('confirmed', 'completed', 'no_show'))
);

create index appointments_start_at_idx on public.appointments (start_at);
create index appointments_status_idx on public.appointments (status);
create index appointments_status_start_at_idx on public.appointments (status, start_at);
create index appointments_telegram_user_id_start_at_idx
  on public.appointments (telegram_user_id, start_at);

create trigger set_updated_at
  before update on public.appointments
  for each row execute function public.set_updated_at();

alter table public.appointments enable row level security;
alter table public.appointments force row level security;

revoke all on table public.appointments from anon, authenticated;

-- Администратор читает записи и меняет статус, но не создаёт и не удаляет
-- их напрямую (создание — только через reserve_appointment, история не
-- уничтожается).
grant select, update on table public.appointments to authenticated;
-- service_role создаёт записи через reserve_appointment и обновляет статус
-- при отмене клиентом.
grant select, insert, update on table public.appointments to service_role;

create policy appointments_admin_select
  on public.appointments
  for select
  to authenticated
  using (public.is_admin());

create policy appointments_admin_update
  on public.appointments
  for update
  to authenticated
  using (public.is_admin())
  with check (public.is_admin());
