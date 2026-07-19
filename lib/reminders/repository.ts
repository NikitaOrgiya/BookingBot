import "server-only";
import { getServiceSupabaseClient } from "@/lib/supabase/server-client";
import {
  mapClaimedReminderRow,
  type ClaimedReminder,
  type ClaimedReminderRow,
} from "./types";

/**
 * Тонкие обёртки над RPC supabase/migrations/
 * 20260719100100_appointment_reminder_functions.sql — вся атомарность и
 * защита от гонок реализована в самих SQL-функциях (row-level локи,
 * FOR UPDATE SKIP LOCKED, processing-lease), этот модуль только
 * типизирует четыре вызова (тот же принцип, что и
 * lib/telegram/idempotency.ts для processed_telegram_updates).
 */

const DEFAULT_BATCH_SIZE = 20;

export async function claimDueAppointmentReminders(
  batchSize: number = DEFAULT_BATCH_SIZE
): Promise<ClaimedReminder[]> {
  const supabase = getServiceSupabaseClient();
  const { data, error } = await supabase.rpc("claim_due_appointment_reminders", {
    p_batch_size: batchSize,
  });

  if (error) {
    throw new Error(
      `Не удалось захватить due-напоминания: ${error.message}`,
      { cause: error }
    );
  }

  return ((data ?? []) as ClaimedReminderRow[]).map(mapClaimedReminderRow);
}

export async function markAppointmentReminderSent(
  reminderId: string,
  telegramMessageId?: number
): Promise<boolean> {
  const supabase = getServiceSupabaseClient();
  const { data, error } = await supabase.rpc("mark_appointment_reminder_sent", {
    p_reminder_id: reminderId,
    p_telegram_message_id: telegramMessageId ?? null,
  });

  if (error) {
    throw new Error(
      `Не удалось отметить напоминание ${reminderId} как отправленное: ${error.message}`,
      { cause: error }
    );
  }

  return data === true;
}

export async function markAppointmentReminderFailed(params: {
  reminderId: string;
  errorCode: string;
  errorMessage: string;
  nextAttemptAt: string | null;
  terminal: boolean;
}): Promise<boolean> {
  const supabase = getServiceSupabaseClient();
  const { data, error } = await supabase.rpc("mark_appointment_reminder_failed", {
    p_reminder_id: params.reminderId,
    p_error_code: params.errorCode,
    p_error_message: params.errorMessage,
    p_next_attempt_at: params.nextAttemptAt,
    p_terminal: params.terminal,
  });

  if (error) {
    throw new Error(
      `Не удалось отметить напоминание ${params.reminderId} как неудачное: ${error.message}`,
      { cause: error }
    );
  }

  return data === true;
}

export interface AppointmentEligibility {
  status: string;
  startAt: string;
}

/**
 * Перечитывает актуальный статус записи ПРЯМО ПЕРЕД отправкой сообщения —
 * claim_due_appointment_reminders гарантирует эксклюзивный захват строки
 * напоминания на момент запроса, но не замораживает саму запись: она
 * могла быть отменена администратором или клиентом уже после claim.
 * Небольшое окно гонки между этим чтением и фактическим вызовом Telegram
 * API остаётся принципиально неустранимым (см. lib/reminders/retry.ts —
 * тот же класс проблемы, что и ambiguous delivery), но эта проверка
 * закрывает подавляющее большинство случаев дешёво и без дополнительной
 * блокировки строки appointments.
 */
export async function getAppointmentEligibility(
  appointmentId: string
): Promise<AppointmentEligibility | null> {
  const supabase = getServiceSupabaseClient();
  const { data, error } = await supabase
    .from("appointments")
    .select("status, start_at")
    .eq("id", appointmentId)
    .maybeSingle<{ status: string; start_at: string }>();

  if (error) {
    throw new Error(
      `Не удалось перепроверить статус записи ${appointmentId}: ${error.message}`,
      { cause: error }
    );
  }
  if (!data) {
    return null;
  }
  return { status: data.status, startAt: data.start_at };
}

export async function markAppointmentReminderSkipped(
  reminderId: string,
  reason?: string
): Promise<boolean> {
  const supabase = getServiceSupabaseClient();
  const { data, error } = await supabase.rpc("mark_appointment_reminder_skipped", {
    p_reminder_id: reminderId,
    p_reason: reason ?? null,
  });

  if (error) {
    throw new Error(
      `Не удалось отметить напоминание ${reminderId} как пропущенное: ${error.message}`,
      { cause: error }
    );
  }

  return data === true;
}
