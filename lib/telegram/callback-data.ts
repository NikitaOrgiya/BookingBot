import { z } from "zod";

/**
 * Централизованный кодек callback_data для инлайн-кнопок бота.
 *
 * Формат: `"1|<action>|<payload>"` — версия, действие, необязательная
 * полезная нагрузка, через `|` (не `:`, потому что payload может быть
 * ISO-датой вида "2026-07-20T11:00:00+00:00", которая сама содержит `:`).
 * Компактный текстовый формат, а не JSON — короче и укладывается в лимит
 * Telegram на длину callback_data (64 байта).
 *
 * Любая строка, которая не проходит decode (неизвестный action,
 * некорректный UUID/дата/номер страницы, сломанный формат, неверная
 * версия), трактуется как устаревшая или подделанная кнопка: decode
 * возвращает null, а не бросает исключение — вызывающий код всегда обязан
 * обработать null явным образом (см. lib/telegram/handlers/callbacks.ts).
 *
 * Бизнес-действия (создание/отмена записи) ВСЕГДА перепроверяются на
 * сервере по актуальным данным (существование услуги, принадлежность
 * записи и т.д.) — то, что здесь разобралось без ошибок, лишь означает
 * "структурно похоже на нашу кнопку", а не "доверенное значение".
 */

const CALLBACK_DATA_VERSION = "1";
const MAX_TELEGRAM_CALLBACK_DATA_BYTES = 64;

const uuidSchema = z.uuid();
const isoDateSchema = z.iso.date(); // YYYY-MM-DD
const isoDateTimeSchema = z.iso.datetime({ offset: true });
const pageSchema = z.coerce.number().int().min(0).max(1000);

export const CALLBACK_ACTIONS = [
  "book",
  "svc",
  "dtpg",
  "dt",
  "back_svc",
  "back_dt",
  "sl",
  "back_sl",
  "cf",
  "abort",
  "myb",
  "ca",
  "cac",
  "cax",
  "hlp",
  "menu",
  "noop",
] as const;

export type CallbackAction = (typeof CALLBACK_ACTIONS)[number];

export type CallbackData =
  | { action: "book" }
  | { action: "svc"; serviceId: string }
  | { action: "dtpg"; page: number }
  | { action: "dt"; date: string }
  | { action: "back_svc" }
  | { action: "back_dt" }
  | { action: "sl"; startAt: string }
  | { action: "back_sl" }
  | { action: "cf"; startAt: string }
  | { action: "abort" }
  | { action: "myb"; page: number }
  | { action: "ca"; appointmentId: string }
  | { action: "cac"; appointmentId: string }
  | { action: "cax" }
  | { action: "hlp" }
  | { action: "menu" }
  | { action: "noop" };

function byteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

/**
 * Кодирует действие в строку callback_data. Бросает исключение (программная
 * ошибка, а не пользовательский ввод), если результат превышает лимит
 * Telegram в 64 байта — это должно быть невозможно при корректном
 * использовании, поэтому здесь не мягкая ошибка, а явный сбой сборки.
 */
export function encodeCallbackData(data: CallbackData): string {
  let payload = "";
  switch (data.action) {
    case "svc":
      payload = data.serviceId;
      break;
    case "dtpg":
      payload = String(data.page);
      break;
    case "dt":
      payload = data.date;
      break;
    case "sl":
      payload = data.startAt;
      break;
    case "cf":
      payload = data.startAt;
      break;
    case "myb":
      payload = String(data.page);
      break;
    case "ca":
      payload = data.appointmentId;
      break;
    case "cac":
      payload = data.appointmentId;
      break;
    default:
      payload = "";
  }

  const raw = `${CALLBACK_DATA_VERSION}|${data.action}|${payload}`;
  const size = byteLength(raw);
  if (size > MAX_TELEGRAM_CALLBACK_DATA_BYTES) {
    throw new Error(
      `callback_data превышает лимит Telegram в ${MAX_TELEGRAM_CALLBACK_DATA_BYTES} байт (${size} байт): ${raw}`
    );
  }
  return raw;
}

/**
 * Разбирает строку callback_data. Возвращает null для чего угодно
 * неожиданного — устаревшей кнопки, чужого/старого формата, повреждённых
 * данных. Никогда не бросает исключение на пользовательский ввод.
 */
export function decodeCallbackData(raw: string): CallbackData | null {
  if (typeof raw !== "string" || raw.length === 0) {
    return null;
  }

  const parts = raw.split("|");
  if (parts.length !== 3) {
    return null;
  }
  const [version, action, payload] = parts;
  if (version !== CALLBACK_DATA_VERSION) {
    return null;
  }
  if (!(CALLBACK_ACTIONS as readonly string[]).includes(action)) {
    return null;
  }

  const typedAction = action as CallbackAction;
  switch (typedAction) {
    case "book":
    case "back_svc":
    case "back_dt":
    case "back_sl":
    case "abort":
    case "cax":
    case "hlp":
    case "menu":
    case "noop":
      return payload === "" ? { action: typedAction } : null;

    case "svc": {
      const result = uuidSchema.safeParse(payload);
      return result.success ? { action: "svc", serviceId: result.data } : null;
    }
    case "ca": {
      const result = uuidSchema.safeParse(payload);
      return result.success
        ? { action: "ca", appointmentId: result.data }
        : null;
    }
    case "cac": {
      const result = uuidSchema.safeParse(payload);
      return result.success
        ? { action: "cac", appointmentId: result.data }
        : null;
    }
    case "dt": {
      const result = isoDateSchema.safeParse(payload);
      return result.success ? { action: "dt", date: result.data } : null;
    }
    case "sl": {
      const result = isoDateTimeSchema.safeParse(payload);
      return result.success ? { action: "sl", startAt: result.data } : null;
    }
    case "cf": {
      const result = isoDateTimeSchema.safeParse(payload);
      return result.success ? { action: "cf", startAt: result.data } : null;
    }
    case "dtpg": {
      const result = pageSchema.safeParse(payload);
      return result.success ? { action: "dtpg", page: result.data } : null;
    }
    case "myb": {
      const result = pageSchema.safeParse(payload);
      return result.success ? { action: "myb", page: result.data } : null;
    }
    default:
      return null;
  }
}
