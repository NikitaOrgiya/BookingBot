import { describe, expect, it } from "vitest";
import {
  addDaysToDateString,
  formatDateForDisplay,
  formatDurationForDisplay,
  formatPriceForDisplay,
  formatTimeForDisplay,
  getTodayDateString,
  toBusinessLocalParts,
} from "@/lib/telegram/formatters";

describe("getTodayDateString: часовой пояс явный, не серверный", () => {
  it("два часовых пояса по разные стороны полуночи дают разную календарную дату", () => {
    // 23:30 UTC — в Токио уже следующий день, а на Гавайях ещё предыдущий.
    const now = new Date("2026-07-20T23:30:00Z");
    expect(getTodayDateString("Asia/Tokyo", now)).toBe("2026-07-21");
    expect(getTodayDateString("Pacific/Honolulu", now)).toBe("2026-07-20");
  });
});

describe("addDaysToDateString", () => {
  it("прибавляет дни, переходя через границу месяца/года", () => {
    expect(addDaysToDateString("2026-07-30", 5)).toBe("2026-08-04");
    expect(addDaysToDateString("2026-12-30", 5)).toBe("2027-01-04");
  });

  it("0 дней не меняет дату", () => {
    expect(addDaysToDateString("2026-07-20", 0)).toBe("2026-07-20");
  });
});

describe("formatDateForDisplay", () => {
  it("форматирует как 'День недели, число месяц' по-русски", () => {
    // 2026-07-20 — понедельник.
    expect(formatDateForDisplay("2026-07-20")).toBe("Пн, 20 июля");
  });
});

describe("toBusinessLocalParts", () => {
  it("раскладывает UTC-момент на локальные дату/время выбранного часового пояса", () => {
    // 09:00 UTC = 12:00 в Москве (UTC+3, без перехода на летнее время).
    const parts = toBusinessLocalParts("2026-07-20T09:00:00Z", "Europe/Moscow");
    expect(parts).toEqual({ date: "2026-07-20", time: "12:00:00" });
  });

  it("календарная дата может отличаться от даты в исходном UTC-моменте", () => {
    // 22:00 UTC = 07:00 следующего дня в Токио (UTC+9).
    const parts = toBusinessLocalParts("2026-07-20T22:00:00Z", "Asia/Tokyo");
    expect(parts).toEqual({ date: "2026-07-21", time: "07:00:00" });
  });

  it("не зависит от локальной таймзоны процесса — тот же instant с двумя business timezone даёт разное локальное время", () => {
    const instant = "2026-07-20T15:00:00Z";
    const moscow = toBusinessLocalParts(instant, "Europe/Moscow");
    const newYork = toBusinessLocalParts(instant, "America/New_York");
    expect(moscow.time).toBe("18:00:00");
    expect(newYork.time).toBe("11:00:00");
  });
});

describe("formatTimeForDisplay", () => {
  it("возвращает HH:MM (без секунд) в указанном часовом поясе", () => {
    expect(formatTimeForDisplay("2026-07-20T09:05:00Z", "Europe/Moscow")).toBe(
      "12:05"
    );
  });
});

describe("formatDurationForDisplay: русская плюрализация", () => {
  it.each([
    [1, "1 минута"],
    [2, "2 минуты"],
    [3, "3 минуты"],
    [4, "4 минуты"],
    [5, "5 минут"],
    [11, "11 минут"],
    [12, "12 минут"],
    [21, "21 минута"],
    [60, "60 минут"],
    [90, "90 минут"],
  ])("%i -> %s", (minutes, expected) => {
    expect(formatDurationForDisplay(minutes)).toBe(expected);
  });
});

describe("formatPriceForDisplay", () => {
  it("null -> 'цена не указана'", () => {
    expect(formatPriceForDisplay(null)).toBe("цена не указана");
  });

  it("форматирует целые рубли без копеек", () => {
    expect(formatPriceForDisplay(200000)).toBe("2 000 ₽");
  });

  it("форматирует дробные рубли с копейками", () => {
    expect(formatPriceForDisplay(150050)).toBe("1 500,5 ₽");
  });

  it("ноль -> '0 ₽'", () => {
    expect(formatPriceForDisplay(0)).toBe("0 ₽");
  });
});
