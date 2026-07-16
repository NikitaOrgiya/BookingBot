import { describe, expect, it } from "vitest";
import {
  cancelAppointmentInputSchema,
  getAvailableSlotsInputSchema,
  reserveAppointmentInputSchema,
} from "@/lib/booking/schemas";

// Валидный UUID v4 (версия/вариант корректны — z.uuid() их проверяет).
const UUID = "f47ac10b-58cc-4372-a567-0e02b2c3d479";

describe("getAvailableSlotsInputSchema", () => {
  it("принимает валидный serviceId без дат", () => {
    const parsed = getAvailableSlotsInputSchema.parse({ serviceId: UUID });
    expect(parsed.serviceId).toBe(UUID);
  });

  it("принимает границы окна в формате YYYY-MM-DD", () => {
    const parsed = getAvailableSlotsInputSchema.parse({
      serviceId: UUID,
      fromDate: "2026-08-01",
      toDate: "2026-08-14",
    });
    expect(parsed.toDate).toBe("2026-08-14");
  });

  it("отклоняет не-UUID serviceId", () => {
    expect(() =>
      getAvailableSlotsInputSchema.parse({ serviceId: "not-a-uuid" })
    ).toThrow();
  });

  it("отклоняет дату с временем вместо чистой даты", () => {
    expect(() =>
      getAvailableSlotsInputSchema.parse({
        serviceId: UUID,
        fromDate: "2026-08-01T10:00:00Z",
      })
    ).toThrow();
  });
});

describe("reserveAppointmentInputSchema", () => {
  const valid = {
    telegramUserId: "123456789",
    serviceId: UUID,
    startAt: "2026-08-01T10:00:00+03:00",
  };

  it("принимает валидный вход c ISO-датой со смещением", () => {
    const parsed = reserveAppointmentInputSchema.parse(valid);
    expect(parsed.telegramUserId).toBe("123456789");
    expect(typeof parsed.telegramUserId).toBe("string");
    expect(parsed.startAt).toBe("2026-08-01T10:00:00+03:00");
  });

  it("принимает telegramUserId больше Number.MAX_SAFE_INTEGER без потери точности", () => {
    // 9007199254740993 = Number.MAX_SAFE_INTEGER + 2. Если бы это значение
    // где-то проходило через Number(), оно округлилось бы до соседнего
    // представимого double (9007199254740992) — round-trip строка -> number
    // -> строка уже не совпадает с исходной. Как строка Zod-схема не делает
    // такого преобразования нигде, поэтому значение доходит без изменений.
    const bigId = "9007199254740993";
    expect(String(Number(bigId))).not.toBe(bigId); // подтверждаем сам риск
    const parsed = reserveAppointmentInputSchema.parse({
      ...valid,
      telegramUserId: bigId,
    });
    expect(parsed.telegramUserId).toBe(bigId);
  });

  it("отклоняет telegramUserId не в виде строки (число как JS-тип)", () => {
    expect(() =>
      reserveAppointmentInputSchema.parse({ ...valid, telegramUserId: 123456789 })
    ).toThrow();
  });

  it("отклоняет некорректные строковые значения telegramUserId", () => {
    for (const bad of ["-1", "1.5", "0", "", "abc", "01", "1e9", " 1", "1 "]) {
      expect(
        () => reserveAppointmentInputSchema.parse({ ...valid, telegramUserId: bad }),
        `ожидалось отклонение значения ${JSON.stringify(bad)}`
      ).toThrow();
    }
  });

  it("отклоняет startAt без таймзоны", () => {
    expect(() =>
      reserveAppointmentInputSchema.parse({
        ...valid,
        startAt: "2026-08-01T10:00:00",
      })
    ).toThrow();
  });
});

describe("cancelAppointmentInputSchema", () => {
  it("принимает валидный вход", () => {
    const parsed = cancelAppointmentInputSchema.parse({
      appointmentId: UUID,
      telegramUserId: "42",
      reason: "передумал",
    });
    expect(parsed.reason).toBe("передумал");
    expect(parsed.telegramUserId).toBe("42");
  });

  it("отклоняет не-UUID appointmentId", () => {
    expect(() =>
      cancelAppointmentInputSchema.parse({
        appointmentId: "x",
        telegramUserId: "42",
      })
    ).toThrow();
  });

  it("отклоняет telegramUserId в виде JS number", () => {
    expect(() =>
      cancelAppointmentInputSchema.parse({
        appointmentId: UUID,
        telegramUserId: 42,
      })
    ).toThrow();
  });
});
