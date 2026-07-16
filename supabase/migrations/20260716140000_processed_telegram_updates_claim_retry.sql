-- Этап 3. Модель claim/process/retry для идемпотентности Telegram webhook.
--
-- До этой миграции service_role имел только SELECT/INSERT на
-- processed_telegram_updates (см. 20260716101000_processed_telegram_updates.sql,
-- не изменяется). Этого было достаточно для однократной регистрации update
-- (конфликт первичного ключа = дубликат), но НЕ хватало для безопасного
-- отката, если бизнес-действие после регистрации не завершилось.
--
-- Модель, реализованная в lib/telegram/idempotency.ts:
--   1. claim: INSERT telegram_update_id (ON CONFLICT DO NOTHING). Успех —
--      update ещё не обрабатывался, можно приступать. Конфликт (0 строк) —
--      это либо уже обрабатываемый параллельно, либо уже полностью
--      обработанный ранее update; в обоих случаях повторное бизнес-действие
--      не выполняется, webhook отвечает Telegram успехом без повтора.
--   2. Если обработка (получение сессии, вызов reserveAppointment/
--      cancelAppointmentByClient и т.п.) выбрасывает ошибку — claim
--      удаляется (release), чтобы Telegram при повторной доставке мог
--      получить новую попытку. Именно поэтому service_role нужен DELETE,
--      которого не было в исходной миграции.
--   3. Если обработка успешна, claim остаётся в таблице навсегда — этот
--      конкретный update_id больше никогда не будет обработан повторно,
--      даже если Telegram зачем-то пришлёт его снова.
--
-- Ни anon, ни authenticated по-прежнему не имеют доступа к этой таблице —
-- ниже отзываем/переиздаём права только для service_role.

revoke all on table public.processed_telegram_updates from service_role;

grant select, insert, delete on table public.processed_telegram_updates
  to service_role;

-- Самопроверка: миграция обязана упасть, если после REVOKE/GRANT права
-- разошлись с ожидаемой моделью (anon/authenticated — ничего;
-- service_role — ровно SELECT+INSERT+DELETE, без UPDATE, который этой
-- модели не требуется).
do $$
declare
  leaked record;
  missing text;
begin
  for leaked in
    select table_name, privilege_type, grantee
    from information_schema.role_table_grants
    where table_schema = 'public'
      and table_name = 'processed_telegram_updates'
      and grantee in ('anon', 'authenticated', 'PUBLIC')
  loop
    raise exception
      'Аудит GRANT провален: % имеет % на public.processed_telegram_updates',
      leaked.grantee, leaked.privilege_type;
  end loop;

  foreach missing in array array['SELECT', 'INSERT', 'DELETE']
  loop
    if not exists (
      select 1
      from information_schema.role_table_grants
      where table_schema = 'public'
        and table_name = 'processed_telegram_updates'
        and grantee = 'service_role'
        and privilege_type = missing
    ) then
      raise exception
        'Аудит GRANT провален: service_role не имеет % на public.processed_telegram_updates',
        missing;
    end if;
  end loop;

  if exists (
    select 1
    from information_schema.role_table_grants
    where table_schema = 'public'
      and table_name = 'processed_telegram_updates'
      and grantee = 'service_role'
      and privilege_type = 'UPDATE'
  ) then
    raise exception
      'Аудит GRANT провален: service_role имеет лишний UPDATE на public.processed_telegram_updates (модель claim/release использует только INSERT/DELETE)';
  end if;
end;
$$;
