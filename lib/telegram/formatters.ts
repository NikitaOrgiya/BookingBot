/**
 * Форматирование дат, времени, цены и длительности для сообщений бота.
 *
 * Часовой пояс всегда передаётся явным параметром (значение читается из
 * business_settings.timezone, см. lib/telegram/repositories/business-settings.ts)
 * — здесь нет ни одного вызова без явного timeZone у Intl.DateTimeFormat,
 * чтобы никогда не использовалась локальная таймзона сервера по умолчанию.
 *
 * Чистые функции без обращения к БД — это сознательный выбор ради простой
 * unit-тестируемости (см. tests/unit/telegram-formatters.test.ts).
 */

function formatDatePartsAsYmd(date: Date, timeZone: string): string {
  // en-CA форматирует дату как YYYY-MM-DD — это единственная причина
  // выбора этой локали здесь, к отображению пользователю отношения не
  // имеет.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

/** Сегодняшняя календарная дата (YYYY-MM-DD) в указанном часовом поясе. */
export function getTodayDateString(timeZone: string, now: Date = new Date()): string {
  return formatDatePartsAsYmd(now, timeZone);
}

/**
 * Календарная дата (YYYY-MM-DD) + N дней. Арифметика делается через дату,
 * заякоренную в UTC-полночь — часовой пояс бизнеса здесь не участвует,
 * потому что YYYY-MM-DD уже абстрактная календарная дата без времени суток
 * (тот же принцип, что использует get_available_slots на стороне SQL).
 */
export function addDaysToDateString(dateString: string, days: number): string {
  const [year, month, day] = dateString.split("-").map(Number);
  const anchor = new Date(Date.UTC(year, month - 1, day));
  anchor.setUTCDate(anchor.getUTCDate() + days);
  return anchor.toISOString().slice(0, 10);
}

const WEEKDAY_FORMATTER = new Intl.DateTimeFormat("ru-RU", {
  timeZone: "UTC",
  weekday: "short",
});
const DAY_MONTH_FORMATTER = new Intl.DateTimeFormat("ru-RU", {
  timeZone: "UTC",
  day: "numeric",
  month: "long",
});

/** "2026-07-20" -> "Пн, 20 июля". timeZone: "UTC" намеренно — dateString
 * уже абстрактная календарная дата, заякоренная в UTC-полночь при парсинге
 * ниже; подстановка часового пояса бизнеса здесь исказила бы календарный
 * день при отрицательном смещении от UTC. */
export function formatDateForDisplay(dateString: string): string {
  const [year, month, day] = dateString.split("-").map(Number);
  const anchor = new Date(Date.UTC(year, month - 1, day));
  const weekday = WEEKDAY_FORMATTER.format(anchor);
  const dayMonth = DAY_MONTH_FORMATTER.format(anchor);
  const capitalizedWeekday = weekday.charAt(0).toUpperCase() + weekday.slice(1);
  return `${capitalizedWeekday}, ${dayMonth}`;
}

function getPart(parts: Intl.DateTimeFormatPart[], type: string): string {
  return parts.find((part) => part.type === type)?.value ?? "";
}

/**
 * Раскладывает абсолютный момент времени (ISO-строка timestamptz) на
 * локальные для бизнеса календарную дату и время суток. Используется и
 * для отображения, и для сравнения "не устарела ли кнопка" при
 * подтверждении брони (см. lib/telegram/handlers/callbacks.ts).
 */
export function toBusinessLocalParts(
  isoDateTime: string,
  timeZone: string
): { date: string; time: string } {
  const instant = new Date(isoDateTime);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(instant);

  const year = getPart(parts, "year");
  const month = getPart(parts, "month");
  const day = getPart(parts, "day");
  let hour = getPart(parts, "hour");
  const minute = getPart(parts, "minute");
  const second = getPart(parts, "second");
  // Некоторые реализации ICU отдают "24" вместо "00" для полуночи при
  // hour12: false.
  if (hour === "24") {
    hour = "00";
  }

  return {
    date: `${year}-${month}-${day}`,
    time: `${hour}:${minute}:${second}`,
  };
}

/** "2026-07-20T11:00:00+00:00" -> "14:00" (в указанном часовом поясе). */
export function formatTimeForDisplay(isoDateTime: string, timeZone: string): string {
  const { time } = toBusinessLocalParts(isoDateTime, timeZone);
  return time.slice(0, 5);
}

function pluralizeRu(n: number, [one, few, many]: [string, string, string]): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) {
    return one;
  }
  if (mod10 >= 2 && mod10 <= 4 && !(mod100 >= 12 && mod100 <= 14)) {
    return few;
  }
  return many;
}

/** 60 -> "60 минут"; 1 -> "1 минута"; 3 -> "3 минуты". */
export function formatDurationForDisplay(minutes: number): string {
  return `${minutes} ${pluralizeRu(minutes, ["минута", "минуты", "минут"])}`;
}

/** 200000 -> "2 000 ₽"; null -> "цена не указана". */
export function formatPriceForDisplay(priceCents: number | null): string {
  if (priceCents === null) {
    return "цена не указана";
  }
  const rubles = priceCents / 100;
  const hasFractionalRubles = priceCents % 100 !== 0;
  const formatted = new Intl.NumberFormat("ru-RU", {
    maximumFractionDigits: hasFractionalRubles ? 2 : 0,
  }).format(rubles);
  return `${formatted} ₽`;
}
