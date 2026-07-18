-- Этап 5. Ops-скрипт: диагностика Supabase Cron job'а напоминаний и
-- последних неудачных напоминаний — только для чтения, ничего не
-- изменяет. Выполняется владельцем проекта вручную через Supabase SQL
-- Editor. Ни один из запросов ниже не раскрывает PII: chat_id, имя
-- клиента, телефон и email не выбираются нигде.

-- 1. Само расписание job'а: активен ли, какое расписание, команда
--    (обратите внимание — команда ссылается на ИМЕНА секретов Vault, а
--    не на их значения, см. setup-reminder-cron.sql).
select jobid, jobname, schedule, active, command
from cron.job
where jobname = 'bookingbot-appointment-reminders';

-- 2. Последние 20 запусков job'а: статус (succeeded/failed) и
--    return_message (безопасный вывод net.http_get/pg_cron, не тело
--    ответа Telegram и не PII).
select runid, jobid, status, return_message, start_time, end_time
from cron.job_run_details
where jobid = (
  select jobid from cron.job where jobname = 'bookingbot-appointment-reminders'
)
order by start_time desc
limit 20;

-- 3. Последние 20 напоминаний со статусом 'failed' — только appointment_id
--    (не имя/телефон/email клиента), тип, число попыток и безопасный код/
--    текст последней ошибки (last_error_message уже ограничен 500
--    символами и никогда не содержит токен/URL/сырой ответ Telegram —
--    см. lib/reminders/retry.ts).
select id, appointment_id, reminder_type, status, attempt_count,
       last_error_code, last_error_message, scheduled_for, updated_at
from public.appointment_reminders
where status = 'failed'
order by updated_at desc
limit 20;

-- 4. Общая сводка по статусам — быстрый health-check без деталей.
select status, count(*) as count
from public.appointment_reminders
group by status
order by status;
