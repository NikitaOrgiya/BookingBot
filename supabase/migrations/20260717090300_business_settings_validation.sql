-- Этап 4. business_settings уже защищён CHECK-ограничениями на
-- booking_horizon_days (1-180), *_notice_minutes/reminder_*_minutes
-- (неотрицательные) и slot_step_minutes (5-120) — см.
-- 20260716100300_business_settings.sql, 20260716120000_..., и
-- 20260716130000_business_settings_slot_step.sql. Не хватало двух
-- проверок: непустое название и настоящий IANA timezone-идентификатор.

-- is_valid_timezone: STABLE, а не IMMUTABLE — результат зависит от версии
-- базы данных tzdata, но не от изменяемых пользовательских данных, поэтому
-- он пригоден для CHECK-ограничения. Ловим любую ошибку целиком (WHEN
-- OTHERS), а не конкретный SQLSTATE: PostgreSQL не документирует единый
-- стабильный код для "такой IANA-зоны не существует" на всех версиях.
create or replace function public.is_valid_timezone(p_timezone text)
returns boolean
language plpgsql
stable
as $$
begin
  perform now() at time zone p_timezone;
  return true;
exception when others then
  return false;
end;
$$;

revoke all on function public.is_valid_timezone(text) from public;
-- CHECK-ограничение выполняется в контексте роли, делающей INSERT/UPDATE
-- (это не SECURITY DEFINER функция) — authenticated делает UPDATE
-- business_settings через панель, поэтому ей нужен явный EXECUTE.
grant execute on function public.is_valid_timezone(text) to authenticated;

-- Проверка существующих данных перед добавлением CHECK: в проекте ровно
-- одна строка-синглтон (id = 1, см. supabase/seed.sql), но миграция не
-- предполагает это как данность — если она не проходит новую проверку,
-- падаем с понятной ошибкой вместо загадочного "check constraint violated"
-- без контекста, и ничего не исправляем автоматически.
do $$
begin
  if exists (
    select 1
      from public.business_settings
     where btrim(business_name) = ''
        or not public.is_valid_timezone(timezone)
  ) then
    raise exception
      'Миграция business_settings_validation прервана: существующая строка business_settings не проходит новую проверку (пустое business_name или невалидный IANA timezone). Исправьте значение вручную через public.business_settings, затем примените миграцию заново.';
  end if;
end;
$$;

alter table public.business_settings
  add constraint business_settings_business_name_not_blank
    check (btrim(business_name) <> '');

alter table public.business_settings
  add constraint business_settings_timezone_valid
    check (public.is_valid_timezone(timezone));
