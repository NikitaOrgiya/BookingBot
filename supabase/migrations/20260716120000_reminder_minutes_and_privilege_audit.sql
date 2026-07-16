-- Корректирующая миграция по итогам аудита Этапа 1. Не переписывает и не
-- заменяет уже применённые миграции — только добавляет два новых
-- ограничения и самопроверяющий блок поверх текущего состояния схемы.

-- ---------------------------------------------------------------------
-- 1. business_settings: reminder_first_minutes и reminder_second_minutes
--    не были защищены от отрицательных значений (в отличие от
--    min_booking_notice_minutes и cancellation_notice_minutes в
--    исходной миграции 20260716100300_business_settings.sql).
-- ---------------------------------------------------------------------

alter table public.business_settings
  add constraint business_settings_reminder_first_non_negative
    check (reminder_first_minutes is null or reminder_first_minutes >= 0);

alter table public.business_settings
  add constraint business_settings_reminder_second_non_negative
    check (reminder_second_minutes is null or reminder_second_minutes >= 0);

-- ---------------------------------------------------------------------
-- 2. Повторно отзываем EXECUTE у PUBLIC на всех функциях схемы public.
--    PostgreSQL по умолчанию выдаёт EXECUTE роли PUBLIC при создании
--    любой новой функции — это уже было отозвано в первой миграции, но
--    переустановка is_admin() через "create or replace function" в
--    последующих правках схемы могла бы незаметно вернуть это поведение,
--    поэтому переотзываем явно и переиздаём только нужный GRANT.
-- ---------------------------------------------------------------------

revoke all on all functions in schema public from public;
grant execute on function public.is_admin() to authenticated;

-- ---------------------------------------------------------------------
-- 3. Самопроверка итоговых прав. Это не просто комментарий с
--    намерением — миграция обязана упасть с ошибкой, если после всех
--    REVOKE/GRANT реальное состояние схемы разошлось с ожидаемым.
-- ---------------------------------------------------------------------

do $$
declare
  leaked record;
begin
  -- 3.1. anon не должен иметь ни одной табличной привилегии в схеме
  -- public — ни выданной лично роли anon, ни через псевдороль PUBLIC
  -- (роли наследуют привилегии PUBLIC автоматически).
  for leaked in
    select table_name, privilege_type, grantee
    from information_schema.role_table_grants
    where table_schema = 'public'
      and grantee in ('anon', 'PUBLIC')
  loop
    raise exception
      'Аудит GRANT провален: % имеет % на public.%',
      leaked.grantee, leaked.privilege_type, leaked.table_name;
  end loop;

  -- 3.2. authenticated не должен иметь вообще никаких привилегий на
  -- таблицах, предназначенных только для service_role/владельца:
  -- admin_users, booking_sessions, processed_telegram_updates.
  for leaked in
    select table_name, privilege_type
    from information_schema.role_table_grants
    where table_schema = 'public'
      and grantee = 'authenticated'
      and table_name in (
        'admin_users', 'booking_sessions', 'processed_telegram_updates'
      )
  loop
    raise exception
      'Аудит GRANT провален: authenticated имеет % на public.% (эта таблица не должна быть доступна панели администратора)',
      leaked.privilege_type, leaked.table_name;
  end loop;

  -- 3.3. authenticated не должен иметь INSERT/DELETE на appointments:
  -- создание — только через будущую reserve_appointment, история не
  -- уничтожается.
  for leaked in
    select privilege_type
    from information_schema.role_table_grants
    where table_schema = 'public'
      and table_name = 'appointments'
      and grantee = 'authenticated'
      and privilege_type in ('INSERT', 'DELETE')
  loop
    raise exception
      'Аудит GRANT провален: authenticated имеет % на public.appointments',
      leaked.privilege_type;
  end loop;

  -- 3.4. Ни одна SECURITY DEFINER функция схемы public не должна быть
  -- выполнима ролью PUBLIC.
  for leaked in
    select p.proname
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.prosecdef
      and has_function_privilege('public', p.oid, 'EXECUTE')
  loop
    raise exception
      'Аудит SECURITY DEFINER провален: public.%() выполним ролью PUBLIC',
      leaked.proname;
  end loop;
end;
$$;
