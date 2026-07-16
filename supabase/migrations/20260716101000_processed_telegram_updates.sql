-- Защита от повторной обработки Telegram webhook: Telegram может повторно
-- отправить update с тем же id, перед обработкой мы пытаемся
-- зарегистрировать его id здесь; конфликт первичного ключа сигнализирует,
-- что update уже обработан.

create table public.processed_telegram_updates (
  telegram_update_id bigint primary key,
  processed_at timestamptz not null default now()
);

alter table public.processed_telegram_updates enable row level security;
alter table public.processed_telegram_updates force row level security;

revoke all on table public.processed_telegram_updates from anon, authenticated;

grant select, insert on table public.processed_telegram_updates to service_role;
