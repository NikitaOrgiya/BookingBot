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
    telegramUserId: 123456789,
    serviceId: UUID,
    startAt: "2026-08-01T10:00:00+03:00",
  };

  it("принимает валидный вход c ISO-датой со смещением", () => {
    const parsed = reserveAppointmentInputSchema.parse(valid);
    expect(parsed.telegramUserId).toBe(123456789);
    expect(parsed.startAt).toBe("2026-08-01T10:00:00+03:00");
  });

  it("отклоняет нецелый/неположительный telegramUserId", () => {
    expect(() =>
      reserveAppointmentInputSchema.parse({ ...valid, telegramUserId: -1 })
    ).toThrow();
    expect(() =>
      reserveAppointmentInputSchema.parse({ ...valid, telegramUserId: 1.5 })
    ).toThrow();
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
      telegramUserId: 42,
      reason: "передумал",
    });
    expect(parsed.reason).toBe("передумал");
  });

  it("отклоняет не-UUID appointmentId", () => {
    expect(() =>
      cancelAppointmentInputSchema.parse({
        appointmentId: "x",
        telegramUserId: 42,
      })
    ).toThrow();
  });
});
