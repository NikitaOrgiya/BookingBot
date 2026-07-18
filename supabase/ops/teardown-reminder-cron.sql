-- Этап 5. Ops-скрипт: отключает Supabase Cron для напоминаний.
-- Не применяется автоматически (см. setup-reminder-cron.sql) — выполняется
-- владельцем проекта вручную через Supabase SQL Editor.
--
-- Секреты в Vault (reminders_cron_url / reminders_cron_secret) этим
-- скриптом НЕ удаляются — только расписание. Если нужно отозвать и сами
-- секреты (например, после ротации CRON_SECRET), сделайте это отдельно:
--   select vault.update_secret(
--     (select id from vault.secrets where name = 'reminders_cron_secret'),
--     '<новое или пустое значение>'
--   );

do $$
declare
  v_job_name constant text := 'bookingbot-appointment-reminders';
begin
  if exists (select 1 from cron.job where jobname = v_job_name) then
    perform cron.unschedule(v_job_name);
    raise notice 'Job "%" остановлен (unscheduled).', v_job_name;
  else
    raise notice 'Job "%" не найден — нечего останавливать.', v_job_name;
  end if;
end;
$$;
