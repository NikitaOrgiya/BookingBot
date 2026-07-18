import type { ReminderType } from "./types";
import { formatDateForDisplay, toBusinessLocalParts } from "@/lib/telegram/formatters";

/**
 * Экранирование для Telegram parse_mode: "HTML" (см. https://core.telegram.org/bots/api#html-style).
 * Достаточно трёх символов: &, <, > — Telegram Bot API не требует
 * экранировать кавычки вне значений атрибутов, которых мы здесь не
 * используем. Порядок важен: сначала "&", иначе символы "&lt;"/"&gt;",
 * появившиеся на втором шаге, были бы экранированы повторно на первом.
 */
export function escapeTelegramHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Название услуги — единственное интерполируемое значение в тексте
 * напоминания, взятое из appointments.service_name_snapshot. Оно
 * административное (задаётся в /admin/services), а не введено клиентом
 * напрямую, но экранируется всё равно: и потому что администратор — не
 * доверенный ввод при parse_mode: "HTML" (случайный "&"/"<" в названии
 * услуги не должен сломать разметку сообщения), и как единообразная
 * защита от HTML injection в принципе.
 *
 * Формулировки соответствуют утверждённому примеру технического задания
 * дословно (включая "примерно через 2 часа" — cron может сработать с
 * небольшой задержкой, поэтому сообщение не утверждает "ровно через 2
 * часа").
 */
export function formatReminderMessage(params: {
  reminderType: ReminderType;
  serviceName: string;
  startAtIso: string;
  timeZone: string;
}): string {
  const { date, time } = toBusinessLocalParts(params.startAtIso, params.timeZone);
  const serviceName = escapeTelegramHtml(params.serviceName);
  const dateDisplay = formatDateForDisplay(date);
  const timeDisplay = time.slice(0, 5);

  const heading =
    params.reminderType === "24h" ? "⏰ Напоминание о записи" : "⏰ Скоро ваша запись";
  const intro =
    params.reminderType === "24h"
      ? "Завтра у вас запись:"
      : "Запись начнётся примерно через 2 часа:";

  return [
    heading,
    "",
    intro,
    `Услуга: <b>${serviceName}</b>`,
    `Дата: ${dateDisplay}`,
    `Время: ${timeDisplay}`,
    "",
    "До встречи!",
  ].join("\n");
}
