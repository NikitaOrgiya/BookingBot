import { describe, expect, it } from "vitest";
import {
  appointmentFilterSchema,
  appointmentStatusChangeSchema,
  businessSettingsFormSchema,
  centsToRubles,
  rublesToCents,
  scheduleBlockFormSchema,
  serviceFormSchema,
  workingHourFormSchema,
} from "@/lib/admin/schemas";

describe("rublesToCents / centsToRubles", () => {
  it("конвертирует целые рубли без потери точности", () => {
    expect(rublesToCents(1800)).toBe(180000);
    expect(centsToRubles(180000)).toBe(1800);
  });

  it("конвертирует дробные рубли (копейки) без ошибок плавающей точки", () => {
    // 19.9 * 100 в чистом JS даёт 1989.9999999999998 без Math.round.
    expect(rublesToCents(19.9)).toBe(1990);
    expect(rublesToCents(0.1)).toBe(10);
  });

  it("0 рублей -> 0 копеек", () => {
    expect(rublesToCents(0)).toBe(0);
  });
});

describe("serviceFormSchema", () => {
  const base = {
    name: "Консультация",
    durationMinutes: 30,
    priceRubles: 500,
    sortOrder: 10,
    isActive: true,
  };

  it("принимает корректные данные", () => {
    expect(serviceFormSchema.safeParse(base).success).toBe(true);
  });

  it("отклоняет пустое название", () => {
    expect(serviceFormSchema.safeParse({ ...base, name: "   " }).success).toBe(false);
  });

  it("отклоняет длительность вне диапазона 5-480", () => {
    expect(serviceFormSchema.safeParse({ ...base, durationMinutes: 4 }).success).toBe(false);
    expect(serviceFormSchema.safeParse({ ...base, durationMinutes: 481 }).success).toBe(false);
  });

  it("отклоняет отрицательную цену", () => {
    expect(serviceFormSchema.safeParse({ ...base, priceRubles: -1 }).success).toBe(false);
  });

  it("отклоняет цену с более чем двумя знаками после запятой", () => {
    expect(serviceFormSchema.safeParse({ ...base, priceRubles: 19.999 }).success).toBe(false);
  });

  it("принимает цену ровно с двумя знаками после запятой", () => {
    expect(serviceFormSchema.safeParse({ ...base, priceRubles: 19.99 }).success).toBe(true);
  });

  it("отклоняет чрезмерно большую цену (защита от переполнения price_cents)", () => {
    expect(serviceFormSchema.safeParse({ ...base, priceRubles: 10_000_000 }).success).toBe(
      false
    );
  });
});

describe("workingHourFormSchema", () => {
  it("принимает корректный интервал", () => {
    expect(
      workingHourFormSchema.safeParse({
        weekday: 0,
        startTime: "09:00",
        endTime: "18:00",
        isActive: true,
      }).success
    ).toBe(true);
  });

  it("отклоняет weekday вне диапазона 0-6", () => {
    expect(
      workingHourFormSchema.safeParse({
        weekday: 7,
        startTime: "09:00",
        endTime: "18:00",
        isActive: true,
      }).success
    ).toBe(false);
  });

  it("отклоняет окончание раньше или равное началу", () => {
    expect(
      workingHourFormSchema.safeParse({
        weekday: 0,
        startTime: "18:00",
        endTime: "09:00",
        isActive: true,
      }).success
    ).toBe(false);
    expect(
      workingHourFormSchema.safeParse({
        weekday: 0,
        startTime: "09:00",
        endTime: "09:00",
        isActive: true,
      }).success
    ).toBe(false);
  });
});

describe("scheduleBlockFormSchema", () => {
  it("принимает корректную блокировку", () => {
    expect(
      scheduleBlockFormSchema.safeParse({
        localDate: "2026-07-20",
        startTime: "14:00",
        endTime: "16:00",
      }).success
    ).toBe(true);
  });

  it("отклоняет окончание раньше или равное началу", () => {
    expect(
      scheduleBlockFormSchema.safeParse({
        localDate: "2026-07-20",
        startTime: "16:00",
        endTime: "14:00",
      }).success
    ).toBe(false);
  });
});

describe("businessSettingsFormSchema", () => {
  const base = {
    businessName: "BookingBot",
    timezone: "Europe/Moscow",
    bookingHorizonDays: 14,
    minBookingNoticeMinutes: 120,
    cancellationNoticeMinutes: 120,
    slotStepMinutes: 15,
    reminderFirstMinutes: null,
    reminderSecondMinutes: null,
  };

  it("принимает корректные настройки", () => {
    expect(businessSettingsFormSchema.safeParse(base).success).toBe(true);
  });

  it("отклоняет невалидный IANA timezone", () => {
    expect(
      businessSettingsFormSchema.safeParse({ ...base, timezone: "Not/AZone" }).success
    ).toBe(false);
    expect(businessSettingsFormSchema.safeParse({ ...base, timezone: "UTC+3" }).success).toBe(
      false
    );
  });

  it("отклоняет пустое название организации", () => {
    expect(businessSettingsFormSchema.safeParse({ ...base, businessName: "  " }).success).toBe(
      false
    );
  });

  it("отклоняет горизонт бронирования вне 1-180", () => {
    expect(
      businessSettingsFormSchema.safeParse({ ...base, bookingHorizonDays: 0 }).success
    ).toBe(false);
    expect(
      businessSettingsFormSchema.safeParse({ ...base, bookingHorizonDays: 181 }).success
    ).toBe(false);
  });

  it("отклоняет шаг слотов вне 5-120", () => {
    expect(businessSettingsFormSchema.safeParse({ ...base, slotStepMinutes: 4 }).success).toBe(
      false
    );
    expect(
      businessSettingsFormSchema.safeParse({ ...base, slotStepMinutes: 121 }).success
    ).toBe(false);
  });

  it("отклоняет отрицательные сроки уведомления/отмены", () => {
    expect(
      businessSettingsFormSchema.safeParse({ ...base, minBookingNoticeMinutes: -1 }).success
    ).toBe(false);
    expect(
      businessSettingsFormSchema.safeParse({ ...base, cancellationNoticeMinutes: -1 }).success
    ).toBe(false);
  });
});

describe("appointmentStatusChangeSchema", () => {
  // Валидный UUID v4 (версия/вариант корректны — z.uuid() их проверяет,
  // тот же приём, что и в tests/unit/booking-schemas.test.ts).
  const UUID = "f47ac10b-58cc-4372-a567-0e02b2c3d479";

  it("принимает допустимые целевые статусы", () => {
    for (const newStatus of ["completed", "cancelled", "no_show"]) {
      expect(
        appointmentStatusChangeSchema.safeParse({
          appointmentId: UUID,
          newStatus,
        }).success
      ).toBe(true);
    }
  });

  it("отклоняет недопустимый целевой статус (confirmed недостижим извне)", () => {
    expect(
      appointmentStatusChangeSchema.safeParse({
        appointmentId: UUID,
        newStatus: "confirmed",
      }).success
    ).toBe(false);
  });
});

describe("appointmentFilterSchema", () => {
  it("по умолчанию page = 1, остальные поля не обязательны", () => {
    const parsed = appointmentFilterSchema.parse({});
    expect(parsed.page).toBe(1);
  });

  it("отклоняет telegramId с нечисловыми символами", () => {
    expect(appointmentFilterSchema.safeParse({ telegramId: "abc" }).success).toBe(false);
  });

  it("принимает числовой telegramId", () => {
    expect(appointmentFilterSchema.safeParse({ telegramId: "123456" }).success).toBe(true);
  });
});
