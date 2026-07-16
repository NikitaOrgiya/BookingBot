import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BotContext } from "@/lib/telegram/context";
import { encodeCallbackData } from "@/lib/telegram/callback-data";
import { IDLE_SESSION_STATE } from "@/lib/telegram/repositories/booking-sessions";
import { CANCEL_SUCCESS_MESSAGE, STALE_BUTTON_MESSAGE } from "@/lib/telegram/messages";
import { BookingError } from "@/lib/booking/errors";

/**
 * Мокаем весь слой доступа к данным (репозитории + lib/booking) — этот
 * файл тестирует только логику диспетчеризации/переходов состояний в
 * lib/telegram/handlers/callbacks.ts, без обращения к реальной БД
 * (см. интеграционные тесты для реального booking_sessions/appointments).
 */
vi.mock("@/lib/telegram/repositories/booking-sessions", async () => {
  const actual = await vi.importActual<
    typeof import("@/lib/telegram/repositories/booking-sessions")
  >("@/lib/telegram/repositories/booking-sessions");
  return {
    ...actual,
    getBookingSession: vi.fn(),
    setBookingSession: vi.fn(),
    clearBookingSession: vi.fn(),
  };
});
vi.mock("@/lib/telegram/repositories/services", () => ({
  listActiveServices: vi.fn(),
  getServiceById: vi.fn(),
}));
vi.mock("@/lib/telegram/repositories/business-settings", () => ({
  getBusinessSettings: vi.fn(),
}));
vi.mock("@/lib/telegram/repositories/appointments", () => ({
  MY_BOOKINGS_PAGE_SIZE: 5,
  listUpcomingAppointments: vi.fn(),
  getOwnAppointmentById: vi.fn(),
  getOwnConfirmedAppointmentBySlot: vi.fn(),
}));
vi.mock("@/lib/booking", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/booking")>("@/lib/booking");
  return {
    ...actual,
    getAvailableSlots: vi.fn(),
    reserveAppointment: vi.fn(),
    cancelAppointmentByClient: vi.fn(),
  };
});

import { getBookingSession, setBookingSession, clearBookingSession } from "@/lib/telegram/repositories/booking-sessions";
import { getServiceById, listActiveServices } from "@/lib/telegram/repositories/services";
import { getBusinessSettings } from "@/lib/telegram/repositories/business-settings";
import {
  getOwnAppointmentById,
  getOwnConfirmedAppointmentBySlot,
  listUpcomingAppointments,
} from "@/lib/telegram/repositories/appointments";
import { getAvailableSlots, reserveAppointment, cancelAppointmentByClient } from "@/lib/booking";
import { handleCallbackQuery } from "@/lib/telegram/handlers/callbacks";

const BUSINESS_SETTINGS = { timezone: "Europe/Moscow", bookingHorizonDays: 14 };
const SERVICE_ID = "9c858901-8a57-4791-81fe-4c455b099bc9";
const APPOINTMENT_ID = "550e8400-e29b-41d4-a716-446655440000";
const OTHER_USER_APPOINTMENT_ID = "660e8400-e29b-41d4-a716-446655440001";

function makeCtx(callbackData: string | undefined): BotContext & {
  editMessageText: ReturnType<typeof vi.fn>;
  reply: ReturnType<typeof vi.fn>;
  answerCallbackQuery: ReturnType<typeof vi.fn>;
} {
  return {
    callbackQuery: callbackData ? { data: callbackData } : undefined,
    telegramUserId: "12345",
    telegramUserRowId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    editMessageText: vi.fn().mockResolvedValue(undefined),
    reply: vi.fn().mockResolvedValue(undefined),
    answerCallbackQuery: vi.fn().mockResolvedValue(undefined),
  } as unknown as BotContext & {
    editMessageText: ReturnType<typeof vi.fn>;
    reply: ReturnType<typeof vi.fn>;
    answerCallbackQuery: ReturnType<typeof vi.fn>;
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getBusinessSettings).mockResolvedValue(BUSINESS_SETTINGS);
});

describe("handleCallbackQuery: answerCallbackQuery всегда вызывается", () => {
  it("для структурно некорректных данных (устаревшая/подделанная кнопка)", async () => {
    const ctx = makeCtx("garbage-not-a-valid-callback");
    vi.mocked(getBookingSession).mockResolvedValue(IDLE_SESSION_STATE);

    await handleCallbackQuery(ctx);

    expect(ctx.answerCallbackQuery).toHaveBeenCalledTimes(1);
    expect(clearBookingSession).toHaveBeenCalledWith("12345");
    expect(ctx.editMessageText).toHaveBeenCalledWith(
      STALE_BUTTON_MESSAGE,
      expect.anything()
    );
  });

  it("даже когда обработчик бросает необработанное исключение", async () => {
    const ctx = makeCtx(encodeCallbackData({ action: "svc", serviceId: SERVICE_ID }));
    vi.mocked(getBookingSession).mockResolvedValue({
      ...IDLE_SESSION_STATE,
      step: "choosing_service",
    });
    vi.mocked(getServiceById).mockRejectedValue(new Error("сбой сети до Supabase"));

    await expect(handleCallbackQuery(ctx)).rejects.toThrow("сбой сети до Supabase");

    expect(ctx.answerCallbackQuery).toHaveBeenCalledTimes(1);
  });

  it("когда сам answerCallbackQuery не может ответить (сообщение недоступно)", async () => {
    const ctx = makeCtx(encodeCallbackData({ action: "menu" }));
    ctx.answerCallbackQuery.mockRejectedValue(new Error("query is too old"));

    await expect(handleCallbackQuery(ctx)).resolves.toBeUndefined();
    expect(ctx.answerCallbackQuery).toHaveBeenCalledTimes(1);
  });
});

describe("handleCallbackQuery: переходы booking_sessions", () => {
  it("svc из состояния choosing_service переводит сессию в choosing_date", async () => {
    const ctx = makeCtx(encodeCallbackData({ action: "svc", serviceId: SERVICE_ID }));
    vi.mocked(getBookingSession).mockResolvedValue({
      ...IDLE_SESSION_STATE,
      step: "choosing_service",
    });
    vi.mocked(getServiceById).mockResolvedValue({
      id: SERVICE_ID,
      name: "Стрижка",
      durationMinutes: 60,
      priceCents: 200000,
      isActive: true,
    });

    await handleCallbackQuery(ctx);

    expect(setBookingSession).toHaveBeenCalledWith(
      "12345",
      expect.objectContaining({ step: "choosing_date", selectedServiceId: SERVICE_ID })
    );
    expect(ctx.answerCallbackQuery).toHaveBeenCalledTimes(1);
  });

  it("svc из состояния idle (устаревшая кнопка) сбрасывает сессию, не продолжая сценарий", async () => {
    const ctx = makeCtx(encodeCallbackData({ action: "svc", serviceId: SERVICE_ID }));
    vi.mocked(getBookingSession).mockResolvedValue(IDLE_SESSION_STATE);

    await handleCallbackQuery(ctx);

    expect(clearBookingSession).toHaveBeenCalledWith("12345");
    expect(getServiceById).not.toHaveBeenCalled();
    expect(ctx.editMessageText).toHaveBeenCalledWith(
      STALE_BUTTON_MESSAGE,
      expect.anything()
    );
  });

  it("деактивированная услуга (server-side ре-проверка) не создаёт сессию с ней", async () => {
    const ctx = makeCtx(encodeCallbackData({ action: "svc", serviceId: SERVICE_ID }));
    vi.mocked(getBookingSession).mockResolvedValue({
      ...IDLE_SESSION_STATE,
      step: "choosing_service",
    });
    vi.mocked(getServiceById).mockResolvedValue({
      id: SERVICE_ID,
      name: "Устаревшая услуга",
      durationMinutes: 60,
      priceCents: null,
      isActive: false,
    });
    vi.mocked(listActiveServices).mockResolvedValue([]);

    await handleCallbackQuery(ctx);

    expect(setBookingSession).not.toHaveBeenCalledWith(
      "12345",
      expect.objectContaining({ selectedServiceId: SERVICE_ID })
    );
  });
});

describe("handleCallbackQuery: подтверждение брони (cf)", () => {
  const startAt = "2026-07-20T09:00:00+00:00"; // 12:00 по Москве

  it("устаревшая кнопка cf (startAt не совпадает с сессией) не вызывает reserveAppointment", async () => {
    const ctx = makeCtx(encodeCallbackData({ action: "cf", startAt }));
    vi.mocked(getBookingSession).mockResolvedValue({
      step: "confirming",
      selectedServiceId: SERVICE_ID,
      selectedDate: "2026-07-21", // другая дата, чем в startAt
      selectedLocalTime: "12:00:00",
    });

    await handleCallbackQuery(ctx);

    expect(reserveAppointment).not.toHaveBeenCalled();
    expect(clearBookingSession).toHaveBeenCalledWith("12345");
  });

  it("SLOT_TAKEN при подтверждении возвращает к выбору времени со свежими слотами (слот реально занял кто-то другой)", async () => {
    const ctx = makeCtx(encodeCallbackData({ action: "cf", startAt }));
    vi.mocked(getBookingSession).mockResolvedValue({
      step: "confirming",
      selectedServiceId: SERVICE_ID,
      selectedDate: "2026-07-20",
      selectedLocalTime: "12:00:00",
    });
    vi.mocked(reserveAppointment).mockRejectedValue(new BookingError("SLOT_TAKEN"));
    vi.mocked(getOwnConfirmedAppointmentBySlot).mockResolvedValue(null);
    vi.mocked(getAvailableSlots).mockResolvedValue([
      { startAt: "2026-07-20T10:00:00+00:00", endAt: "2026-07-20T11:00:00+00:00" },
    ]);

    await handleCallbackQuery(ctx);

    expect(getOwnConfirmedAppointmentBySlot).toHaveBeenCalledWith(
      "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      SERVICE_ID,
      startAt
    );
    expect(setBookingSession).toHaveBeenCalledWith(
      "12345",
      expect.objectContaining({ step: "choosing_slot", selectedLocalTime: null })
    );
    expect(getAvailableSlots).toHaveBeenCalledWith(
      expect.objectContaining({ serviceId: SERVICE_ID })
    );
    expect(ctx.answerCallbackQuery).toHaveBeenCalledTimes(1);
  });

  it("SLOT_TAKEN, но своя confirmed-запись на тот же service/start уже существует -> идемпотентный успех, а не ложный SLOT_TAKEN (повтор доставки confirm-колбэка после аварии до complete_telegram_update)", async () => {
    const ctx = makeCtx(encodeCallbackData({ action: "cf", startAt }));
    vi.mocked(getBookingSession).mockResolvedValue({
      step: "confirming",
      selectedServiceId: SERVICE_ID,
      selectedDate: "2026-07-20",
      selectedLocalTime: "12:00:00",
    });
    vi.mocked(reserveAppointment).mockRejectedValue(new BookingError("SLOT_TAKEN"));
    const existingAppointment = {
      id: APPOINTMENT_ID,
      telegramUserRowId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      serviceId: SERVICE_ID,
      serviceName: "Стрижка",
      durationMinutes: 60,
      priceCents: 200000,
      startAt,
      endAt: "2026-07-20T10:00:00+00:00",
      status: "confirmed" as const,
      clientNote: null,
      cancelledAt: null,
      cancelReason: null,
      createdAt: startAt,
      updatedAt: startAt,
    };
    vi.mocked(getOwnConfirmedAppointmentBySlot).mockResolvedValue(existingAppointment);

    await handleCallbackQuery(ctx);

    expect(getOwnConfirmedAppointmentBySlot).toHaveBeenCalledWith(
      "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      SERVICE_ID,
      startAt
    );
    // Идемпотентный успех: сессия очищена, свежие слоты НЕ запрашивались,
    // пользователь не увидел "слот занят" за свою же запись.
    expect(clearBookingSession).toHaveBeenCalledWith("12345");
    expect(getAvailableSlots).not.toHaveBeenCalled();
    expect(ctx.editMessageText).toHaveBeenCalledWith(
      expect.stringContaining("подтверждена"),
      expect.anything()
    );
  });

  it("успешное бронирование очищает booking_session", async () => {
    const ctx = makeCtx(encodeCallbackData({ action: "cf", startAt }));
    vi.mocked(getBookingSession).mockResolvedValue({
      step: "confirming",
      selectedServiceId: SERVICE_ID,
      selectedDate: "2026-07-20",
      selectedLocalTime: "12:00:00",
    });
    vi.mocked(reserveAppointment).mockResolvedValue({
      id: APPOINTMENT_ID,
      telegramUserRowId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      serviceId: SERVICE_ID,
      serviceName: "Стрижка",
      durationMinutes: 60,
      priceCents: 200000,
      startAt,
      endAt: "2026-07-20T10:00:00+00:00",
      status: "confirmed",
      clientNote: null,
      cancelledAt: null,
      cancelReason: null,
      createdAt: startAt,
      updatedAt: startAt,
    });

    await handleCallbackQuery(ctx);

    expect(clearBookingSession).toHaveBeenCalledWith("12345");
  });
});

describe("handleCallbackQuery: отмена своей записи vs подделанный appointmentId", () => {
  it("ca с чужим/несуществующим appointmentId не раскрывает данные — падает обратно на список", async () => {
    const ctx = makeCtx(encodeCallbackData({ action: "ca", appointmentId: OTHER_USER_APPOINTMENT_ID }));
    vi.mocked(getOwnAppointmentById).mockResolvedValue(null);
    vi.mocked(listUpcomingAppointments).mockResolvedValue({ appointments: [], hasMore: false });

    await handleCallbackQuery(ctx);

    expect(getOwnAppointmentById).toHaveBeenCalledWith(
      "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      OTHER_USER_APPOINTMENT_ID
    );
    expect(listUpcomingAppointments).toHaveBeenCalled();
  });
});

describe("handleCallbackQuery: подтверждение отмены (cac) — идемпотентный повтор", () => {
  it("успешная отмена показывает CANCEL_SUCCESS_MESSAGE", async () => {
    const ctx = makeCtx(encodeCallbackData({ action: "cac", appointmentId: APPOINTMENT_ID }));
    vi.mocked(cancelAppointmentByClient).mockResolvedValue({
      id: APPOINTMENT_ID,
      telegramUserRowId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      serviceId: SERVICE_ID,
      serviceName: "Стрижка",
      durationMinutes: 60,
      priceCents: 200000,
      startAt: "2026-07-20T09:00:00+00:00",
      endAt: "2026-07-20T10:00:00+00:00",
      status: "cancelled",
      clientNote: null,
      cancelledAt: "2026-07-20T08:00:00+00:00",
      cancelReason: null,
      createdAt: "2026-07-19T00:00:00+00:00",
      updatedAt: "2026-07-20T08:00:00+00:00",
    });

    await handleCallbackQuery(ctx);

    expect(ctx.editMessageText).toHaveBeenCalledWith(
      CANCEL_SUCCESS_MESSAGE,
      expect.anything()
    );
  });

  it("ALREADY_CANCELLED (повторная доставка cac после аварии до ответа Telegram) -> безопасный идемпотентный успех, а не ошибка", async () => {
    const ctx = makeCtx(encodeCallbackData({ action: "cac", appointmentId: APPOINTMENT_ID }));
    vi.mocked(cancelAppointmentByClient).mockRejectedValue(
      new BookingError("ALREADY_CANCELLED")
    );

    await handleCallbackQuery(ctx);

    // Ровно CANCEL_SUCCESS_MESSAGE, а НЕ
    // formatBookingErrorMessage("ALREADY_CANCELLED") ("Эта запись уже
    // отменена.") — оба текста содержат слово "отменена", поэтому здесь
    // важно точное сравнение, а не подстрока.
    expect(ctx.editMessageText).toHaveBeenCalledWith(
      CANCEL_SUCCESS_MESSAGE,
      expect.anything()
    );
    expect(ctx.answerCallbackQuery).toHaveBeenCalledTimes(1);
  });

  it("APPOINTMENT_NOT_OWNED по-прежнему показывает обычную ошибку, а не идемпотентный успех — чужая запись не подменяется", async () => {
    const ctx = makeCtx(encodeCallbackData({ action: "cac", appointmentId: OTHER_USER_APPOINTMENT_ID }));
    vi.mocked(cancelAppointmentByClient).mockRejectedValue(
      new BookingError("APPOINTMENT_NOT_OWNED")
    );

    await handleCallbackQuery(ctx);

    expect(ctx.editMessageText).not.toHaveBeenCalledWith(
      CANCEL_SUCCESS_MESSAGE,
      expect.anything()
    );
  });
});
