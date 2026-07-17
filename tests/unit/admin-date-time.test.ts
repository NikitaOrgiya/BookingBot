import { describe, expect, it } from "vitest";
import {
  getBusinessDayBounds,
  getBusinessWeekBounds,
  isValidIanaTimeZone,
  localDateTimeToUtcIso,
} from "@/lib/admin/date-time";

describe("localDateTimeToUtcIso", () => {
  it("Europe/Moscow — постоянно UTC+3 (без перехода на летнее время)", () => {
    expect(localDateTimeToUtcIso("2026-07-20", "00:00:00", "Europe/Moscow")).toBe(
      "2026-07-19T21:00:00.000Z"
    );
    expect(localDateTimeToUtcIso("2026-07-20", "14:00:00", "Europe/Moscow")).toBe(
      "2026-07-20T11:00:00.000Z"
    );
  });

  it("Asia/Tokyo — UTC+9", () => {
    expect(localDateTimeToUtcIso("2026-07-20", "09:00:00", "Asia/Tokyo")).toBe(
      "2026-07-20T00:00:00.000Z"
    );
  });
});

describe("getBusinessDayBounds: границы 'сегодня' считаются в business timezone", () => {
  it("полночь-полночь Europe/Moscow как UTC-интервал", () => {
    // 2026-07-20 10:00 UTC = 13:00 в Москве — тот же календарный день.
    const now = new Date("2026-07-20T10:00:00Z");
    const bounds = getBusinessDayBounds("Europe/Moscow", now);
    expect(bounds.todayDateString).toBe("2026-07-20");
    expect(bounds.startIso).toBe("2026-07-19T21:00:00.000Z");
    expect(bounds.endIso).toBe("2026-07-20T21:00:00.000Z");
  });

  it("два часовых пояса по разные стороны полуночи дают разную календарную дату", () => {
    // 23:30 UTC — в Токио уже следующий день, а на Гавайях ещё предыдущий
    // (тот же принцип, что и в tests/unit/telegram-formatters.test.ts).
    const now = new Date("2026-07-20T23:30:00Z");
    expect(getBusinessDayBounds("Asia/Tokyo", now).todayDateString).toBe("2026-07-21");
    expect(getBusinessDayBounds("Pacific/Honolulu", now).todayDateString).toBe("2026-07-20");
  });
});

describe("getBusinessWeekBounds: неделя Пн-Вс (0 = понедельник, как working_hours)", () => {
  it("середина недели -> границы той же недели (понедельник 2026-07-20)", () => {
    // 2026-07-20 — понедельник (см. tests/unit/telegram-formatters.test.ts).
    const friday = new Date("2026-07-24T10:00:00Z");
    const bounds = getBusinessWeekBounds("Europe/Moscow", friday);
    expect(bounds.weekStartDateString).toBe("2026-07-20");
    expect(bounds.startIso).toBe("2026-07-19T21:00:00.000Z");
    expect(bounds.endIso).toBe("2026-07-26T21:00:00.000Z");
  });

  it("сам понедельник -> тот же понедельник как начало недели", () => {
    const monday = new Date("2026-07-20T10:00:00Z");
    expect(getBusinessWeekBounds("Europe/Moscow", monday).weekStartDateString).toBe(
      "2026-07-20"
    );
  });

  it("воскресенье -> начало той же недели (предыдущий понедельник)", () => {
    // 2026-07-26 — воскресенье той же недели, что и понедельник 2026-07-20.
    const sunday = new Date("2026-07-26T10:00:00Z");
    expect(getBusinessWeekBounds("Europe/Moscow", sunday).weekStartDateString).toBe(
      "2026-07-20"
    );
  });
});

describe("isValidIanaTimeZone", () => {
  it.each(["Europe/Moscow", "Asia/Tokyo", "UTC", "America/New_York"])(
    "%s -> true",
    (tz) => {
      expect(isValidIanaTimeZone(tz)).toBe(true);
    }
  );

  it.each(["Not/AZone", "UTC+3", "Moscow", ""])("%s -> false", (tz) => {
    expect(isValidIanaTimeZone(tz)).toBe(false);
  });
});
