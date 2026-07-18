import { GrammyError } from "grammy";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Юнит-тесты control-flow воркера напоминаний (lib/reminders/worker.ts).
 * Мокаем только транспорт (getServiceSupabaseClient — claim/mark_-функции,
 * getAppointmentEligibility) и getBot().api.sendMessage — вся остальная
 * логика (цикл по batch'у, пред-отправочная перепроверка, классификация
 * ошибок, вычисление backoff) реальная, невтронутая. Тот же принцип, что
 * и у tests/unit/booking-reserve-appointment.test.ts: быстро и
 * детерминированно проверяет ветки, которые ненадёжно/невозможно
 * спровоцировать в реальной гонке (например, "Telegram вернул 500 именно
 * для второго напоминания в batch'е из трёх"). Настоящую атомарность
 * claim на живом PostgreSQL проверяет tests/integration/appointment-reminders.test.ts.
 */

const rpcMock = vi.fn();
const fromMock = vi.fn();
const sendMessageMock = vi.fn();

vi.mock("@/lib/supabase/server-client", () => ({
  getServiceSupabaseClient: () => ({ rpc: rpcMock, from: fromMock }),
}));

vi.mock("@/lib/telegram/bot", () => ({
  getBot: () => ({ api: { sendMessage: sendMessageMock } }),
}));

import { processDueAppointmentReminders } from "@/lib/reminders/worker";

function claimedRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    reminder_id: "11111111-1111-4111-8111-111111111111",
    appointment_id: "22222222-2222-4222-8222-222222222222",
    reminder_type: "2h",
    attempt_count: 1,
    chat_id: 5001,
    service_name: "Стрижка",
    start_at: new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString(),
    business_name: "BookingBot",
    timezone: "Europe/Moscow",
    ...overrides,
  };
}

/** Настраивает fromMock так, что getAppointmentEligibility() для ЛЮБОГО
 * appointment_id возвращает status='confirmed' и start_at в будущем
 * (запись остаётся подходящей для отправки) — переопределяется по месту,
 * где нужно другое поведение. */
function mockEligible(startAtIso: string = claimedRow().start_at as string) {
  fromMock.mockReturnValue({
    select: () => ({
      eq: () => ({
        maybeSingle: async () => ({
          data: { status: "confirmed", start_at: startAtIso },
          error: null,
        }),
      }),
    }),
  });
}

function mockRpc(handlers: Record<string, (params: Record<string, unknown>) => unknown>) {
  rpcMock.mockImplementation(async (name: string, params: Record<string, unknown>) => {
    if (!(name in handlers)) {
      throw new Error(`Неожиданный rpc-вызов в тесте: ${name}`);
    }
    return { data: handlers[name](params), error: null };
  });
}

/** Аргументы (params) последнего вызова rpc(name, params) с данным именем. */
function rpcCallParams(name: string): Record<string, unknown> | undefined {
  const call = rpcMock.mock.calls.find(([callName]) => callName === name);
  return call?.[1] as Record<string, unknown> | undefined;
}

beforeEach(() => {
  rpcMock.mockReset();
  fromMock.mockReset();
  sendMessageMock.mockReset();
});

describe("processDueAppointmentReminders: базовые случаи", () => {
  it("claim не вернул ни одной строки -> summary из нулей, send не вызывается", async () => {
    mockRpc({ claim_due_appointment_reminders: () => [] });

    const summary = await processDueAppointmentReminders();

    expect(summary).toEqual({ claimed: 0, sent: 0, failed: 0, skipped: 0 });
    expect(sendMessageMock).not.toHaveBeenCalled();
  });

  it("успешная отправка -> mark_appointment_reminder_sent, summary.sent = 1", async () => {
    const row = claimedRow();
    mockEligible(row.start_at as string);
    sendMessageMock.mockResolvedValue({ message_id: 777 });
    mockRpc({
      claim_due_appointment_reminders: () => [row],
      mark_appointment_reminder_sent: () => true,
    });

    const summary = await processDueAppointmentReminders();

    expect(summary).toEqual({ claimed: 1, sent: 1, failed: 0, skipped: 0 });
    expect(sendMessageMock).toHaveBeenCalledWith(
      row.chat_id,
      expect.any(String),
      { parse_mode: "HTML" }
    );
    expect(rpcCallParams("mark_appointment_reminder_sent")).toEqual(
      expect.objectContaining({
        p_reminder_id: row.reminder_id,
        p_telegram_message_id: 777,
      })
    );
  });
});

describe("processDueAppointmentReminders: пред-отправочная перепроверка", () => {
  it("запись отменена между claim и отправкой -> mark_skipped, Telegram НЕ вызывается", async () => {
    const row = claimedRow();
    fromMock.mockReturnValue({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({
            data: { status: "cancelled", start_at: row.start_at },
            error: null,
          }),
        }),
      }),
    });
    mockRpc({
      claim_due_appointment_reminders: () => [row],
      mark_appointment_reminder_skipped: () => true,
    });

    const summary = await processDueAppointmentReminders();

    expect(summary).toEqual({ claimed: 1, sent: 0, failed: 0, skipped: 1 });
    expect(sendMessageMock).not.toHaveBeenCalled();
    expect(rpcCallParams("mark_appointment_reminder_skipped")).toEqual(
      expect.objectContaining({ p_reminder_id: row.reminder_id })
    );
  });

  it("запись уже началась между claim и отправкой -> mark_skipped", async () => {
    const row = claimedRow();
    fromMock.mockReturnValue({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({
            data: { status: "confirmed", start_at: new Date(Date.now() - 1000).toISOString() },
            error: null,
          }),
        }),
      }),
    });
    mockRpc({
      claim_due_appointment_reminders: () => [row],
      mark_appointment_reminder_skipped: () => true,
    });

    const summary = await processDueAppointmentReminders();
    expect(summary.skipped).toBe(1);
    expect(sendMessageMock).not.toHaveBeenCalled();
  });
});

describe("processDueAppointmentReminders: ошибка одного чата не ломает весь batch", () => {
  it("Telegram упал для первого напоминания, второе всё равно отправляется", async () => {
    const failing = claimedRow({
      reminder_id: "11111111-1111-4111-8111-111111111111",
      appointment_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      attempt_count: 1,
    });
    const succeeding = claimedRow({
      reminder_id: "33333333-3333-4333-8333-333333333333",
      appointment_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      attempt_count: 1,
    });

    mockEligible(failing.start_at as string);

    sendMessageMock
      .mockRejectedValueOnce(
        new GrammyError(
          "fail",
          { ok: false, error_code: 500, description: "Internal Server Error" },
          "sendMessage",
          {}
        )
      )
      .mockResolvedValueOnce({ message_id: 42 });

    mockRpc({
      claim_due_appointment_reminders: () => [failing, succeeding],
      mark_appointment_reminder_failed: () => true,
      mark_appointment_reminder_sent: () => true,
    });

    const summary = await processDueAppointmentReminders();

    expect(summary).toEqual({ claimed: 2, sent: 1, failed: 1, skipped: 0 });
    expect(sendMessageMock).toHaveBeenCalledTimes(2);
    expect(rpcCallParams("mark_appointment_reminder_failed")).toEqual(
      expect.objectContaining({ p_reminder_id: failing.reminder_id, p_terminal: false })
    );
    expect(rpcCallParams("mark_appointment_reminder_sent")).toEqual(
      expect.objectContaining({ p_reminder_id: succeeding.reminder_id })
    );
  });

  it("постоянная ошибка Telegram (403) -> терминальный failed сразу, без ожидания 5 попыток", async () => {
    const row = claimedRow({ attempt_count: 1 });
    mockEligible(row.start_at as string);
    sendMessageMock.mockRejectedValue(
      new GrammyError(
        "fail",
        { ok: false, error_code: 403, description: "Forbidden: bot was blocked by the user" },
        "sendMessage",
        {}
      )
    );
    mockRpc({
      claim_due_appointment_reminders: () => [row],
      mark_appointment_reminder_failed: () => true,
    });

    await processDueAppointmentReminders();

    expect(rpcCallParams("mark_appointment_reminder_failed")).toEqual(
      expect.objectContaining({ p_terminal: true, p_error_code: "TELEGRAM_403" })
    );
  });

  it("исчерпаны все 5 попыток -> терминальный failed, даже если ошибка формально retryable", async () => {
    const row = claimedRow({ attempt_count: 5 });
    mockEligible(row.start_at as string);
    sendMessageMock.mockRejectedValue(
      new GrammyError(
        "fail",
        { ok: false, error_code: 500, description: "Internal Server Error" },
        "sendMessage",
        {}
      )
    );
    mockRpc({
      claim_due_appointment_reminders: () => [row],
      mark_appointment_reminder_failed: () => true,
    });

    await processDueAppointmentReminders();

    expect(rpcCallParams("mark_appointment_reminder_failed")).toEqual(
      expect.objectContaining({ p_terminal: true })
    );
  });
});
