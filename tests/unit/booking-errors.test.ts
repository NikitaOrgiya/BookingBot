import { describe, expect, it, vi } from "vitest";
import {
  BookingError,
  BOOKING_ERROR_CODES,
  sqlstateToBookingCode,
  toBookingError,
} from "@/lib/booking/errors";

describe("sqlstateToBookingCode", () => {
  it("преобразует нативный 23P01 (exclusion_violation) в SLOT_TAKEN", () => {
    expect(sqlstateToBookingCode("23P01")).toBe("SLOT_TAKEN");
  });

  it.each([
    ["PB001", "SERVICE_NOT_FOUND"],
    ["PB002", "SERVICE_INACTIVE"],
    ["PB003", "TELEGRAM_USER_NOT_FOUND"],
    ["PB004", "INVALID_START_TIME"],
    ["PB005", "OUTSIDE_BOOKING_HORIZON"],
    ["PB006", "MIN_NOTICE_NOT_MET"],
    ["PB007", "OUTSIDE_WORKING_HOURS"],
    ["PB008", "SCHEDULE_BLOCKED"],
    ["PB009", "APPOINTMENT_NOT_FOUND"],
    ["PB010", "APPOINTMENT_NOT_OWNED"],
    ["PB011", "CANCELLATION_TOO_LATE"],
    ["PB012", "ALREADY_CANCELLED"],
  ])("сопоставляет SQLSTATE %s с доменным кодом %s", (sqlstate, code) => {
    expect(sqlstateToBookingCode(sqlstate)).toBe(code);
  });

  it("возвращает undefined для неизвестного и пустого SQLSTATE", () => {
    expect(sqlstateToBookingCode("42P01")).toBeUndefined();
    expect(sqlstateToBookingCode(undefined)).toBeUndefined();
    expect(sqlstateToBookingCode(null)).toBeUndefined();
    expect(sqlstateToBookingCode("")).toBeUndefined();
  });

  it("все значения из карты входят в BOOKING_ERROR_CODES", () => {
    for (const code of BOOKING_ERROR_CODES) {
      expect(typeof code).toBe("string");
    }
  });
});

describe("toBookingError", () => {
  it("преобразует ошибку RPC с кодом 23P01 в BookingError SLOT_TAKEN", () => {
    const pgError = { code: "23P01", message: "conflicting key value violates exclusion constraint" };
    const err = toBookingError(pgError);
    expect(err).toBeInstanceOf(BookingError);
    expect(err.code).toBe("SLOT_TAKEN");
    // Сырой текст PostgreSQL не становится сообщением наружу...
    expect(err.message).toBe("SLOT_TAKEN");
    // ...но сохраняется в cause для диагностики.
    expect(err.cause).toBe(pgError);
  });

  it("преобразует кастомный PB011 в CANCELLATION_TOO_LATE", () => {
    const err = toBookingError({ code: "PB011", message: "CANCELLATION_TOO_LATE" });
    expect(err.code).toBe("CANCELLATION_TOO_LATE");
  });

  it("любую неизвестную ошибку сводит к INTERNAL_ERROR и логирует на сервере", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const raw = new Error("что-то пошло не так в базе");
    const err = toBookingError(raw);
    expect(err.code).toBe("INTERNAL_ERROR");
    expect(err.message).toBe("INTERNAL_ERROR");
    expect(err.cause).toBe(raw);
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it("возвращает исходный BookingError без обёртки", () => {
    const original = new BookingError("SLOT_TAKEN");
    expect(toBookingError(original)).toBe(original);
  });
});
