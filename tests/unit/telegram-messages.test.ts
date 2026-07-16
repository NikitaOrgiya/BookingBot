import { describe, expect, it } from "vitest";
import { BOOKING_ERROR_CODES, type BookingErrorCode } from "@/lib/booking/errors";
import { formatBookingErrorMessage } from "@/lib/telegram/messages";

describe("formatBookingErrorMessage: доменный код -> сообщение клиенту", () => {
  it("покрывает каждый код из BOOKING_ERROR_CODES непустым русским сообщением", () => {
    for (const code of BOOKING_ERROR_CODES) {
      const message = formatBookingErrorMessage(code);
      expect(typeof message).toBe("string");
      expect(message.length).toBeGreaterThan(0);
    }
  });

  it("сообщения различны для разных кодов (не один общий текст на всё)", () => {
    const messages = BOOKING_ERROR_CODES.map((code) => formatBookingErrorMessage(code));
    expect(new Set(messages).size).toBe(BOOKING_ERROR_CODES.length);
  });

  it("ни одно сообщение не содержит сырых признаков SQL/PostgreSQL", () => {
    const suspiciousMarkers = [
      "SELECT",
      "INSERT",
      "SQLSTATE",
      "constraint",
      "PB0",
      "23P01",
      "postgres",
    ];
    for (const code of BOOKING_ERROR_CODES) {
      const message = formatBookingErrorMessage(code);
      for (const marker of suspiciousMarkers) {
        expect(message.toLowerCase()).not.toContain(marker.toLowerCase());
      }
    }
  });

  it("SLOT_TAKEN явно объясняет, что слот заняли только что", () => {
    expect(formatBookingErrorMessage("SLOT_TAKEN")).toMatch(/занял/);
  });

  it("INTERNAL_ERROR не раскрывает внутренние детали", () => {
    const message = formatBookingErrorMessage("INTERNAL_ERROR" as BookingErrorCode);
    expect(message).toBe("Что-то пошло не так. Попробуйте ещё раз чуть позже.");
  });
});
