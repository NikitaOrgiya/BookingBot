import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Юнит-тесты retry-логики reserveAppointment на 40P01 (deadlock_detected).
 * Мокаем только транспорт (getServiceSupabaseClient().rpc) — вся остальная
 * логика (retry-цикл, преобразование ошибок, сборка Appointment) реальная.
 * Настоящую конкурентную гонку на живом PostgreSQL проверяет
 * tests/integration/reserve-appointment-race.test.ts — здесь же быстро и
 * детерминированно проверяются все ветки retry-цикла, включая те, которые
 * невозможно надёжно спровоцировать в реальной гонке (например, "40P01 три
 * раза подряд").
 */

const rpcMock = vi.fn();

vi.mock("@/lib/supabase/server-client", () => ({
  getServiceSupabaseClient: () => ({ rpc: rpcMock }),
}));

import { reserveAppointment } from "@/lib/booking/reserve-appointment";
import { BookingError } from "@/lib/booking/errors";

const VALID_INPUT = {
  telegramUserId: "12345",
  serviceId: "9c858901-8a57-4791-81fe-4c455b099bc9",
  startAt: "2026-07-20T09:00:00+00:00",
};

const APPOINTMENT_ROW = {
  id: "550e8400-e29b-41d4-a716-446655440000",
  telegram_user_id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
  service_id: VALID_INPUT.serviceId,
  service_name_snapshot: "Стрижка",
  duration_minutes_snapshot: 60,
  price_cents_snapshot: 200000,
  start_at: VALID_INPUT.startAt,
  end_at: "2026-07-20T10:00:00+00:00",
  status: "confirmed",
  client_note: null,
  cancelled_at: null,
  cancel_reason: null,
  created_at: VALID_INPUT.startAt,
  updated_at: VALID_INPUT.startAt,
};

const DEADLOCK_ERROR = { code: "40P01", message: "deadlock detected" };
const EXCLUSION_ERROR = { code: "23P01", message: "exclusion_violation" };

beforeEach(() => {
  rpcMock.mockReset();
});

describe("reserveAppointment: успех", () => {
  it("успех с первой попытки — rpc вызван ровно один раз", async () => {
    rpcMock.mockResolvedValue({ data: APPOINTMENT_ROW, error: null });

    const result = await reserveAppointment(VALID_INPUT);

    expect(result.id).toBe(APPOINTMENT_ROW.id);
    expect(rpcMock).toHaveBeenCalledTimes(1);
  });
});

describe("reserveAppointment: retry на 40P01", () => {
  it("40P01 -> повтор -> успех", async () => {
    rpcMock
      .mockResolvedValueOnce({ data: null, error: DEADLOCK_ERROR })
      .mockResolvedValueOnce({ data: APPOINTMENT_ROW, error: null });

    const result = await reserveAppointment(VALID_INPUT);

    expect(result.id).toBe(APPOINTMENT_ROW.id);
    expect(rpcMock).toHaveBeenCalledTimes(2);
    // Повторяется вся RPC-операция с теми же параметрами, а не что-то частичное.
    expect(rpcMock.mock.calls[0]).toEqual(rpcMock.mock.calls[1]);
  });

  it("40P01 -> повтор -> 23P01 -> стабильный SLOT_TAKEN", async () => {
    rpcMock
      .mockResolvedValueOnce({ data: null, error: DEADLOCK_ERROR })
      .mockResolvedValueOnce({ data: null, error: EXCLUSION_ERROR });

    await expect(reserveAppointment(VALID_INPUT)).rejects.toMatchObject({
      code: "SLOT_TAKEN",
    });
    expect(rpcMock).toHaveBeenCalledTimes(2);
  });

  it("40P01 на всех попытках подряд -> исчерпаны повторы -> стабильный SLOT_TAKEN, не INTERNAL_ERROR", async () => {
    rpcMock.mockResolvedValue({ data: null, error: DEADLOCK_ERROR });

    const err = await reserveAppointment(VALID_INPUT).catch((e) => e);

    expect(err).toBeInstanceOf(BookingError);
    expect(err.code).toBe("SLOT_TAKEN");
    expect(err.code).not.toBe("INTERNAL_ERROR");
    // MAX_RESERVE_ATTEMPTS в lib/booking/reserve-appointment.ts = 3
    // (1 исходная попытка + 2 повтора).
    expect(rpcMock).toHaveBeenCalledTimes(3);
  });

  it("исходная ошибка 40P01 сохраняется в cause финального BookingError", async () => {
    rpcMock.mockResolvedValue({ data: null, error: DEADLOCK_ERROR });

    const err: InstanceType<typeof BookingError> = await reserveAppointment(
      VALID_INPUT
    ).catch((e) => e);

    expect(err.cause).toMatchObject({ code: "40P01" });
  });
});

describe("reserveAppointment: прочие SQLSTATE не повторяются", () => {
  it("23P01 с первой попытки -> SLOT_TAKEN без повтора", async () => {
    rpcMock.mockResolvedValue({ data: null, error: EXCLUSION_ERROR });

    await expect(reserveAppointment(VALID_INPUT)).rejects.toMatchObject({
      code: "SLOT_TAKEN",
    });
    expect(rpcMock).toHaveBeenCalledTimes(1);
  });

  it("доменный SQLSTATE (PB003 TELEGRAM_USER_NOT_FOUND) не повторяется", async () => {
    rpcMock.mockResolvedValue({
      data: null,
      error: { code: "PB003", message: "TELEGRAM_USER_NOT_FOUND" },
    });

    await expect(reserveAppointment(VALID_INPUT)).rejects.toMatchObject({
      code: "TELEGRAM_USER_NOT_FOUND",
    });
    expect(rpcMock).toHaveBeenCalledTimes(1);
  });

  it("неизвестный SQLSTATE -> INTERNAL_ERROR без повтора", async () => {
    rpcMock.mockResolvedValue({
      data: null,
      error: { code: "53300", message: "too many connections" },
    });

    await expect(reserveAppointment(VALID_INPUT)).rejects.toMatchObject({
      code: "INTERNAL_ERROR",
    });
    expect(rpcMock).toHaveBeenCalledTimes(1);
  });
});
