-- Этап 5. Ops-скрипт: включает Supabase Cron для регулярного вызова
-- GET /api/cron/reminders (примерно раз в 5 минут).
--
-- НЕ применяется автоматически: этот файл лежит в supabase/ops/, а не в
-- supabase/migrations/, поэтому ни `supabase db reset`, ни CI его не
-- запускают. Выполняется владельцем проекта ВРУЧНУЮ через Supabase SQL
-- Editor (или `psql`) ПОСЛЕ:
--   1) merge PR Этапа 5 в main и успешного Production Deployment;
--   2) создания секретов в Supabase Vault (см. команды ниже — здесь
--      только ИМЕНА секретов и инструкция, реальные значения никогда не
--      попадают ни в этот файл, ни в Git, ни в вывод какой-либо команды);
--   3) отдельного явного подтверждения владельца проекта — сам факт
--      наличия этого файла в репозитории НЕ активирует cron.
--
-- Почему Supabase Cron, а не Vercel Cron — см. README.md, раздел "Этап 5:
-- автоматические напоминания" -> "Выбор планировщика". Коротко: частота
-- "каждые ~5 минут" на Vercel Cron требует плана, который нельзя
-- достоверно определить программно в этой среде, а Supabase Cron не
-- накладывает такого ограничения. Не настраивайте оба планировщика
-- одновременно — это создаст дублирующие вызовы одного и того же
-- эндпоинта.
--
-- Требуемые расширения (в проектах Supabase обычно уже включены):
create extension if not exists pg_cron;
create extension if not exists pg_net;

-- -----------------------------------------------------------------------
-- Шаг 1 (выполняется один раз, вручную, ДО этого скрипта): секреты в Vault.
-- -----------------------------------------------------------------------
--
-- Замените плейсхолдеры на реальные значения непосредственно в SQL Editor
-- (не сохраняйте эту команду с реальными значениями нигде, включая
-- историю команд):
--
--   select vault.create_secret(
--     'https://<ваш-production-домен>/api/cron/reminders',
--     'reminders_cron_url'
--   );
--   select vault.create_secret(
--     '<значение CRON_SECRET из production-окружения Vercel>',
--     'reminders_cron_secret'
--   );
--
-- Обновление уже существующего секрета (например, после ротации
-- CRON_SECRET):
--
--   select vault.update_secret(
--     (select id from vault.secrets where name = 'reminders_cron_secret'),
--     '<новое значение>'
--   );

-- -----------------------------------------------------------------------
-- Шаг 2: (пере)создание job'а. Идемпотентно — повторный запуск не создаёт
-- дубликат, а пересоздаёт job с тем же стабильным именем.
-- -----------------------------------------------------------------------
do $$
declare
  v_job_name constant text := 'bookingbot-appointment-reminders';
  v_has_url boolean;
  v_has_secret boolean;
begin
  select exists (
    select 1 from vault.decrypted_secrets where name = 'reminders_cron_url'
  ) into v_has_url;
  select exists (
    select 1 from vault.decrypted_secrets where name = 'reminders_cron_secret'
  ) into v_has_secret;

  if not v_has_url or not v_has_secret then
    raise exception
      'Vault secrets "reminders_cron_url"/"reminders_cron_secret" не найдены — создайте их перед запуском (см. комментарий в начале файла)';
  end if;

  if exists (select 1 from cron.job where jobname = v_job_name) then
    perform cron.unschedule(v_job_name);
  end if;

  -- ВАЖНО: URL и секрет резолвятся из vault.decrypted_secrets КАЖДЫЙ РАЗ
  -- при выполнении job'а, а не подставляются как литералы в этот
  -- DO-блок — иначе реальное значение секрета осело бы открытым текстом
  -- в cron.job.command (системная таблица pg_cron), сводя на нет смысл
  -- хранить его в Vault. Здесь в cron.job.command попадает только текст
  -- запроса со ссылкой на ИМЕНА секретов.
  perform cron.schedule(
    v_job_name,
    '*/5 * * * *',
    $job$
    select net.http_get(
      url := (
        select decrypted_secret from vault.decrypted_secrets
        where name = 'reminders_cron_url'
      ),
      headers := jsonb_build_object(
        'Authorization',
        'Bearer ' || (
          select decrypted_secret from vault.decrypted_secrets
          where name = 'reminders_cron_secret'
        )
      ),
      timeout_milliseconds := 10000
    );
    $job$
  );

  raise notice 'Job "%" запланирован (*/5 * * * *).', v_job_name;
end;
$$;
