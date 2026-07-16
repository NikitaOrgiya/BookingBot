-- Этап 2. Самопроверка прав на функции ядра бронирования — по образцу
-- аудита из 20260716120000_reminder_minutes_and_privilege_audit.sql. Это не
-- комментарий с намерением: миграция ОБЯЗАНА упасть с ошибкой при
-- применении, если реальные EXECUTE-привилегии новых функций разошлись с
-- ожидаемой моделью безопасности (только service_role может выполнять их).

do $$
declare
  fn text;
  fns text[] := array[
    'public.get_available_slots(uuid, date, date)',
    'public.reserve_appointment(bigint, uuid, timestamptz, text)',
    'public.cancel_appointment_by_client(uuid, bigint, text)'
  ];
begin
  foreach fn in array fns loop
    -- 1. Ни PUBLIC, ни anon, ни authenticated не должны иметь EXECUTE.
    if has_function_privilege('public', fn, 'EXECUTE') then
      raise exception
        'Аудит функций провален: % выполнима ролью PUBLIC', fn;
    end if;
    if has_function_privilege('anon', fn, 'EXECUTE') then
      raise exception
        'Аудит функций провален: % выполнима ролью anon', fn;
    end if;
    if has_function_privilege('authenticated', fn, 'EXECUTE') then
      raise exception
        'Аудит функций провален: % выполнима ролью authenticated', fn;
    end if;

    -- 2. service_role — единственная роль, которой EXECUTE обязателен.
    if not has_function_privilege('service_role', fn, 'EXECUTE') then
      raise exception
        'Аудит функций провален: service_role НЕ может выполнить % (нужен GRANT EXECUTE)', fn;
    end if;

    -- 3. Функции ядра бронирования не должны быть SECURITY DEFINER:
    -- service_role уже имеет BYPASSRLS и все нужные GRANT, повышать права
    -- незачем (см. модель безопасности в 20260716130100).
    if (select p.prosecdef from pg_proc p where p.oid = fn::regprocedure) then
      raise exception
        'Аудит функций провален: % объявлена SECURITY DEFINER без необходимости', fn;
    end if;

    -- 4. Фиксированный search_path обязателен.
    if not (
      (select p.proconfig from pg_proc p where p.oid = fn::regprocedure)
        @> array['search_path=public, pg_temp']
    ) then
      raise exception
        'Аудит функций провален: у % не зафиксирован search_path=public, pg_temp', fn;
    end if;
  end loop;
end;
$$;
