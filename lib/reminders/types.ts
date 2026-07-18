/**
 * Стабильные типы Этапа 5 (автоматические Telegram-напоминания). Отделены
 * от «сырых» строк RPC — см. lib/booking/types.ts для того же принципа.
 */

export type ReminderType = "24h" | "2h";

export type ReminderStatus =
  | "pending"
  | "processing"
  | "sent"
  | "failed"
  | "skipped";

/**
 * Одна claim'нутая (захваченная) строка напоминания вместе со всеми
 * данными, нужными worker-у для отправки сообщения — без отдельного
 * похода в БД за appointment/telegram_user/business_settings (см.
 * claim_due_appointment_reminders в supabase/migrations/
 * 20260719100100_appointment_reminder_functions.sql, которая уже
 * возвращает всё одним запросом).
 */
export interface ClaimedReminder {
  reminderId: string;
  appointmentId: string;
  reminderType: ReminderType;
  /** Значение attempt_count ПОСЛЕ этого захвата (т.е. номер этой попытки). */
  attemptCount: number;
  chatId: number;
  serviceName: string;
  startAt: string;
  businessName: string;
  timeZone: string;
}

/** Форма строки, как её возвращает claim_due_appointment_reminders (PostgREST). */
export interface ClaimedReminderRow {
  reminder_id: string;
  appointment_id: string;
  reminder_type: ReminderType;
  attempt_count: number;
  chat_id: number;
  service_name: string;
  start_at: string;
  business_name: string;
  timezone: string;
}

export function mapClaimedReminderRow(row: ClaimedReminderRow): ClaimedReminder {
  return {
    reminderId: row.reminder_id,
    appointmentId: row.appointment_id,
    reminderType: row.reminder_type,
    attemptCount: row.attempt_count,
    chatId: row.chat_id,
    serviceName: row.service_name,
    startAt: row.start_at,
    businessName: row.business_name,
    timeZone: row.timezone,
  };
}

/** Итог обработки одного claim-batch'а — то же, что отдаёт /api/cron/reminders. */
export interface ReminderRunSummary {
  claimed: number;
  sent: number;
  failed: number;
  skipped: number;
}
