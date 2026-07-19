import "server-only";
import { getBot } from "@/lib/telegram/bot";
import { formatReminderMessage } from "./message";
import {
  claimDueAppointmentReminders,
  getAppointmentEligibility,
  markAppointmentReminderFailed,
  markAppointmentReminderSent,
  markAppointmentReminderSkipped,
} from "./repository";
import {
  classifyTelegramError,
  computeNextAttemptDelaySeconds,
  extractSafeErrorCode,
  extractSafeErrorMessage,
  isTerminalAttempt,
} from "./retry";
import type { ClaimedReminder, ReminderRunSummary } from "./types";

/**
 * Один прогон обработки due-напоминаний: claim batch -> для каждой
 * захваченной строки — перепроверка appointment -> отправка -> фиксация
 * результата. Ошибка одного чата (например, бот заблокирован конкретным
 * клиентом) ловится ВНУТРИ цикла и не прерывает обработку остальных строк
 * batch'а — см. catch на каждой итерации.
 *
 * Логи здесь и во всех вызываемых функциях содержат только reminder_id/
 * appointment_id/безопасный код ошибки — никогда chat_id, имя клиента,
 * телефон, email или сырой ответ Telegram API (см. lib/reminders/retry.ts:
 * extractSafeErrorCode/extractSafeErrorMessage).
 */
export async function processDueAppointmentReminders(
  batchSize?: number
): Promise<ReminderRunSummary> {
  const claimed = await claimDueAppointmentReminders(batchSize);

  const summary: ReminderRunSummary = {
    claimed: claimed.length,
    sent: 0,
    failed: 0,
    skipped: 0,
  };

  for (const reminder of claimed) {
    const outcome = await processOneReminder(reminder);
    summary[outcome] += 1;
  }

  return summary;
}

async function processOneReminder(
  reminder: ClaimedReminder
): Promise<"sent" | "failed" | "skipped"> {
  try {
    const eligibility = await getAppointmentEligibility(reminder.appointmentId);

    if (
      !eligibility ||
      eligibility.status !== "confirmed" ||
      new Date(eligibility.startAt).getTime() <= Date.now()
    ) {
      await markAppointmentReminderSkipped(
        reminder.reminderId,
        "APPOINTMENT_NO_LONGER_ELIGIBLE"
      );
      return "skipped";
    }

    const text = formatReminderMessage({
      reminderType: reminder.reminderType,
      serviceName: reminder.serviceName,
      startAtIso: reminder.startAt,
      timeZone: reminder.timeZone,
    });

    const message = await getBot().api.sendMessage(reminder.chatId, text, {
      parse_mode: "HTML",
    });

    await markAppointmentReminderSent(reminder.reminderId, message.message_id);
    return "sent";
  } catch (error) {
    return await handleReminderFailure(reminder, error);
  }
}

async function handleReminderFailure(
  reminder: ClaimedReminder,
  error: unknown
): Promise<"failed" | "skipped"> {
  const classification = classifyTelegramError(error);
  const terminal = !classification.retryable || isTerminalAttempt(reminder.attemptCount);

  const delaySeconds = computeNextAttemptDelaySeconds(
    reminder.attemptCount,
    classification.retryAfterSeconds
  );
  const nextAttemptAt = terminal
    ? null
    : new Date(Date.now() + delaySeconds * 1000).toISOString();

  console.error("[reminders] Не удалось отправить напоминание:", {
    reminderId: reminder.reminderId,
    appointmentId: reminder.appointmentId,
    reminderType: reminder.reminderType,
    attemptCount: reminder.attemptCount,
    terminal,
    errorCode: extractSafeErrorCode(error),
  });

  await markAppointmentReminderFailed({
    reminderId: reminder.reminderId,
    errorCode: extractSafeErrorCode(error),
    errorMessage: extractSafeErrorMessage(error),
    nextAttemptAt,
    terminal,
  });

  return "failed";
}
