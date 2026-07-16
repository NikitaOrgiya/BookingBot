import type { BookingErrorCode } from "@/lib/booking/errors";
import type { Appointment } from "@/lib/booking/types";
import {
  formatDateForDisplay,
  formatDurationForDisplay,
  formatPriceForDisplay,
  toBusinessLocalParts,
} from "./formatters";

/**
 * Русскоязычные тексты сообщений бота. Вынесены отдельно от обработчиков,
 * чтобы формулировки менялись в одном месте и было легко писать unit-тесты
 * на форматирование (см. tests/unit/telegram-messages.test.ts).
 */

export const WELCOME_MESSAGE =
  "Здравствуйте! Я помогу записаться на приём.\n\nВыберите действие:";

export const MAIN_MENU_MESSAGE = "Выберите действие:";

export const HELP_MESSAGE = [
  "Доступные команды:",
  "/start — главное меню",
  "/book — записаться на приём",
  "/mybookings — мои записи",
  "/cancel — отменить текущий незавершённый сценарий записи",
  "/help — эта справка",
].join("\n");

export const GROUP_CHAT_MESSAGE =
  "Этот бот работает только в личных сообщениях. Напишите мне напрямую.";

export const STALE_BUTTON_MESSAGE =
  "Эта кнопка уже неактуальна. Начните заново: /start";

export const NO_ACTIVE_BOOKING_MESSAGE =
  "Сейчас нет активного сценария записи. Начните заново: /book";

export const NO_ACTIVE_SERVICES_MESSAGE =
  "Сейчас нет доступных услуг для записи. Попробуйте позже.";

export const NO_SLOTS_MESSAGE =
  "На эту дату свободного времени нет. Выберите другой день.";

export const BOOKING_ABORTED_MESSAGE = "Бронирование отменено.";

export const NO_UPCOMING_APPOINTMENTS_MESSAGE =
  "У вас пока нет предстоящих записей.";

export const CANCEL_ABORTED_MESSAGE = "Хорошо, запись остаётся в силе.";

export function formatServiceListMessage(): string {
  return "Выберите услугу:";
}

export function formatDateListMessage(serviceName: string): string {
  return `Услуга: ${serviceName}\nВыберите дату:`;
}

export function formatSlotListMessage(dateString: string): string {
  return `Дата: ${formatDateForDisplay(dateString)}\nВыберите время:`;
}

export function formatConfirmationMessage(params: {
  serviceName: string;
  durationMinutes: number;
  priceCents: number | null;
  startAtIso: string;
  timeZone: string;
}): string {
  const { date, time } = toBusinessLocalParts(params.startAtIso, params.timeZone);
  return [
    "Проверьте данные записи:",
    "",
    `Услуга: ${params.serviceName}`,
    `Дата: ${formatDateForDisplay(date)}`,
    `Время: ${time.slice(0, 5)}`,
    `Длительность: ${formatDurationForDisplay(params.durationMinutes)}`,
    `Стоимость: ${formatPriceForDisplay(params.priceCents)}`,
    `Часовой пояс: ${params.timeZone}`,
  ].join("\n");
}

export function formatBookingSuccessMessage(
  appointment: Appointment,
  timeZone: string
): string {
  const { date, time } = toBusinessLocalParts(appointment.startAt, timeZone);
  return [
    "✅ Запись подтверждена.",
    `${formatDateForDisplay(date)} в ${time.slice(0, 5)}.`,
    "",
    "За некоторое время до визита я пришлю напоминание.",
  ].join("\n");
}

export function formatAppointmentSummary(
  appointment: Appointment,
  timeZone: string,
  index: number
): string {
  const { date, time } = toBusinessLocalParts(appointment.startAt, timeZone);
  return [
    `${index + 1}. ${appointment.serviceName}`,
    `   ${formatDateForDisplay(date)} в ${time.slice(0, 5)}`,
    `   Длительность: ${formatDurationForDisplay(appointment.durationMinutes)}`,
    `   Стоимость: ${formatPriceForDisplay(appointment.priceCents)}`,
  ].join("\n");
}

export function formatMyBookingsMessage(
  appointments: Appointment[],
  timeZone: string
): string {
  if (appointments.length === 0) {
    return NO_UPCOMING_APPOINTMENTS_MESSAGE;
  }
  return [
    "Ваши предстоящие записи:",
    "",
    ...appointments.map((appointment, index) =>
      formatAppointmentSummary(appointment, timeZone, index)
    ),
  ].join("\n\n");
}

export function formatCancelConfirmPrompt(
  appointment: Appointment,
  timeZone: string
): string {
  const { date, time } = toBusinessLocalParts(appointment.startAt, timeZone);
  return `Отменить запись «${appointment.serviceName}» на ${formatDateForDisplay(date)} в ${time.slice(0, 5)}?`;
}

export const CANCEL_SUCCESS_MESSAGE =
  "Запись отменена. Освободившееся время снова доступно для бронирования.";

/**
 * Доменный код ошибки бронирования/отмены -> сообщение для пользователя.
 * Сырые сообщения PostgreSQL/SQLSTATE сюда никогда не попадают (см.
 * lib/booking/errors.ts) — таблица покрывает каждый код из
 * BOOKING_ERROR_CODES явно, без catch-all, чтобы забытый новый код
 * заметили на этапе типов, а не в проде.
 */
const BOOKING_ERROR_MESSAGES: Record<BookingErrorCode, string> = {
  SERVICE_NOT_FOUND: "Эта услуга больше не найдена. Выберите услугу заново: /book",
  SERVICE_INACTIVE:
    "Эта услуга сейчас недоступна для записи. Выберите другую услугу.",
  TELEGRAM_USER_NOT_FOUND:
    "Не удалось найти ваш профиль. Отправьте /start ещё раз.",
  INVALID_START_TIME: "Некорректное время записи. Начните выбор времени заново.",
  OUTSIDE_BOOKING_HORIZON:
    "Эта дата слишком далеко в будущем. Выберите более близкую дату.",
  MIN_NOTICE_NOT_MET:
    "До этого времени осталось слишком мало — выберите время попозже.",
  OUTSIDE_WORKING_HOURS:
    "Это время вне рабочего расписания. Выберите время из списка.",
  SCHEDULE_BLOCKED: "Это время временно недоступно. Выберите другое время.",
  SLOT_TAKEN:
    "Это время только что занял другой клиент. Пожалуйста, выберите другой свободный слот.",
  APPOINTMENT_NOT_FOUND:
    "Эта запись не найдена — возможно, она уже была отменена.",
  APPOINTMENT_NOT_OWNED: "Эта запись вам не принадлежит.",
  CANCELLATION_TOO_LATE:
    "Самостоятельная отмена уже недоступна. Свяжитесь с администратором.",
  ALREADY_CANCELLED: "Эта запись уже отменена.",
  APPOINTMENT_NOT_CANCELLABLE:
    "Эту запись нельзя отменить: она уже завершена или отмечена как неявка.",
  INTERNAL_ERROR: "Что-то пошло не так. Попробуйте ещё раз чуть позже.",
};

export function formatBookingErrorMessage(code: BookingErrorCode): string {
  return BOOKING_ERROR_MESSAGES[code];
}
