import { addDaysToDateString, getTodayDateString } from "@/lib/telegram/formatters";

export {
  formatDateForDisplay,
  formatDurationForDisplay,
  formatPriceForDisplay,
  formatTimeForDisplay,
} from "@/lib/telegram/formatters";

/**
 * Границы "сегодня"/"текущей недели" для dashboard всегда считаются в
 * business_settings.timezone, а не в timezone браузера администратора или
 * сервера Vercel — иначе счётчики на дашборде и реальное расписание бота
 * могли бы разойтись на несколько часов вокруг полуночи.
 *
 * Реализация без внешних tz-библиотек (тот же приём, что и
 * lib/telegram/formatters.ts:toBusinessLocalParts, но в обратную сторону):
 * берём "наивный" UTC-инстант для локальной даты/времени, узнаём через
 * Intl.DateTimeFormat, каким гражданским временем в нужной timezone он
 * является, и по разнице получаем настоящее смещение для сдвига.
 */
function getTimeZoneOffsetMinutes(timeZone: string, instant: Date): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(instant);

  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "0";
  const asUtcMs = Date.UTC(
    Number(get("year")),
    Number(get("month")) - 1,
    Number(get("day")),
    Number(get("hour")) === 24 ? 0 : Number(get("hour")),
    Number(get("minute")),
    Number(get("second"))
  );

  return (asUtcMs - instant.getTime()) / 60000;
}

/** "2026-07-20" + "00:00:00" + "Europe/Moscow" -> ISO-строка настоящего
 * UTC-инстанта полуночи этого календарного дня в указанном часовом поясе. */
export function localDateTimeToUtcIso(
  dateString: string,
  timeString: string,
  timeZone: string
): string {
  const naiveUtcMs = Date.parse(`${dateString}T${timeString}Z`);
  const offsetMinutes = getTimeZoneOffsetMinutes(timeZone, new Date(naiveUtcMs));
  return new Date(naiveUtcMs - offsetMinutes * 60_000).toISOString();
}

export interface DayBounds {
  /** Локальная календарная дата (YYYY-MM-DD) business timezone. */
  todayDateString: string;
  /** [startIso, endIso) — полуоткрытый интервал "сегодня" в UTC ISO. */
  startIso: string;
  endIso: string;
}

export function getBusinessDayBounds(timeZone: string, now: Date = new Date()): DayBounds {
  const todayDateString = getTodayDateString(timeZone, now);
  const tomorrowDateString = addDaysToDateString(todayDateString, 1);
  return {
    todayDateString,
    startIso: localDateTimeToUtcIso(todayDateString, "00:00:00", timeZone),
    endIso: localDateTimeToUtcIso(tomorrowDateString, "00:00:00", timeZone),
  };
}

export interface WeekBounds {
  /** Понедельник текущей недели, локальная дата business timezone. */
  weekStartDateString: string;
  startIso: string;
  endIso: string;
}

/** Текущая ISO-неделя (понедельник 00:00 — следующий понедельник 00:00) в
 * business timezone. 0 = понедельник — как и в public.working_hours. */
export function getBusinessWeekBounds(timeZone: string, now: Date = new Date()): WeekBounds {
  const todayDateString = getTodayDateString(timeZone, now);
  const [year, month, day] = todayDateString.split("-").map(Number);
  const anchor = new Date(Date.UTC(year, month - 1, day));
  const isoWeekday = anchor.getUTCDay() === 0 ? 7 : anchor.getUTCDay(); // 1 (Пн) .. 7 (Вс)

  const weekStartDateString = addDaysToDateString(todayDateString, -(isoWeekday - 1));
  const nextWeekStartDateString = addDaysToDateString(weekStartDateString, 7);

  return {
    weekStartDateString,
    startIso: localDateTimeToUtcIso(weekStartDateString, "00:00:00", timeZone),
    endIso: localDateTimeToUtcIso(nextWeekStartDateString, "00:00:00", timeZone),
  };
}

/** Настоящий IANA-идентификатор часового пояса (то же условие, что и
 * public.is_valid_timezone на стороне базы — здесь для мгновенной
 * серверной/клиентской валидации формы без обращения к БД). */
export function isValidIanaTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format(new Date());
    return true;
  } catch {
    return false;
  }
}
