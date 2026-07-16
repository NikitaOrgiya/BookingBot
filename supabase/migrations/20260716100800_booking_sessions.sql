-- Временное состояние диалога с ботом. Нужно, потому что приложение
-- работает в serverless-среде и не может надёжно хранить состояние
-- пользователя в оперативной памяти между запросами. Сессии считаются
-- недействительными после expires_at (проверяется в коде бота).

create table public.booking_sessions (
  telegram_user_id bigint primary key,
  step text not null,
  selected_service_id uuid references public.services (id),
  selected_date date,
  selected_local_time time,
  expires_at timestamptz not null,
  updated_at timestamptz not null default now()
);

create index booking_sessions_expires_at_idx on public.booking_sessions (expires_at);

create trigger set_updated_at
  before update on public.booking_sessions
  for each row execute function public.set_updated_at();

alter table public.booking_sessions enable row level security;
alter table public.booking_sessions force row level security;

-- Состояние диалога с ботом никому, кроме серверного кода бота, не нужно:
-- ни анонимному клиенту, ни администратору в панели.
revoke all on table public.booking_sessions from anon, authenticated;

grant select, insert, update, delete on table public.booking_sessions to service_role;
