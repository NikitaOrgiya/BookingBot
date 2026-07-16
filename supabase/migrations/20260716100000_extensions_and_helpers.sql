-- Расширения и общие вспомогательные объекты, используемые остальными
-- миграциями BookingBot.

-- Нужно для exclusion constraint на appointments (защита от двойного
-- бронирования, см. 20260716100900_appointments.sql).
create extension if not exists btree_gist;

-- Единая триггерная функция для полей updated_at: значение обновляется
-- в базе данных, а не полагается на код приложения.
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- По умолчанию PostgreSQL выдаёт роли PUBLIC право EXECUTE на каждую новую
-- функцию, а Supabase по умолчанию выдаёт anon/authenticated широкие права
-- на таблицы схемы public. Отзываем это явно в самом начале миграций и
-- далее для каждой новой таблицы/функции выдаём только необходимые права.
revoke all on all functions in schema public from public;
revoke all on all tables in schema public from anon;
revoke all on all tables in schema public from authenticated;
