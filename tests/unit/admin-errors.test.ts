import { describe, expect, it } from "vitest";
import { AdminActionError, toAdminActionMessage, toAdminError } from "@/lib/admin/errors";

describe("toAdminError: SQLSTATE -> доменный код административных RPC", () => {
  it.each([
    ["42501", "NOT_ADMIN"],
    ["PB009", "APPOINTMENT_NOT_FOUND"],
    ["PB014", "INVALID_STATUS_TRANSITION"],
    ["PB015", "INVALID_BLOCK_RANGE"],
    ["PB016", "SCHEDULE_BLOCK_NOT_FOUND"],
    ["PB017", "PAST_SCHEDULE_BLOCK_IMMUTABLE"],
    ["23P01", "WORKING_HOURS_OVERLAP"],
  ] as const)("%s -> %s", (code, expected) => {
    expect(toAdminError({ code }).code).toBe(expected);
  });

  it("неизвестный SQLSTATE -> INTERNAL_ERROR (сырой текст не показывается)", () => {
    const original = { code: "99999", message: "какая-то внутренняя деталь PostgreSQL" };
    const result = toAdminError(original);
    expect(result.code).toBe("INTERNAL_ERROR");
    expect(result.message).not.toContain("внутренняя деталь");
  });

  it("уже AdminActionError возвращается как есть (не оборачивается повторно)", () => {
    const original = new AdminActionError("NOT_ADMIN");
    expect(toAdminError(original)).toBe(original);
  });

  it("ошибка без code -> INTERNAL_ERROR", () => {
    expect(toAdminError(new Error("network fail")).code).toBe("INTERNAL_ERROR");
  });
});

describe("toAdminActionMessage: сообщение для Server Actions — никогда не сырой error.message", () => {
  it("известный код -> стабильное доменное сообщение", () => {
    expect(toAdminActionMessage({ code: "23P01" }, "запасное сообщение")).toBe(
      "Интервал пересекается с существующим расписанием."
    );
    expect(toAdminActionMessage({ code: "PB017" }, "запасное сообщение")).toBe(
      "Эту прошедшую блокировку уже нельзя изменить."
    );
    expect(toAdminActionMessage({ code: "42501" }, "запасное сообщение")).toBe(
      "У вас нет прав администратора для этого действия."
    );
  });

  it("неизвестная ошибка -> контекстный fallback вызывающего действия, не error.message", () => {
    const raw = {
      code: "23505",
      message: "duplicate key value violates unique constraint \"services_pkey\"",
    };
    const result = toAdminActionMessage(raw, "Не удалось сохранить услугу.");
    expect(result).toBe("Не удалось сохранить услугу.");
    expect(result).not.toContain("duplicate key");
    expect(result).not.toContain("constraint");
  });

  it("ошибка без code (например, сетевая) -> тот же контекстный fallback", () => {
    const raw = new Error("connect ECONNREFUSED 127.0.0.1:5432 — pg_hba.conf rejects connection");
    const result = toAdminActionMessage(raw, "Не удалось сохранить настройки.");
    expect(result).toBe("Не удалось сохранить настройки.");
    expect(result).not.toContain("ECONNREFUSED");
    expect(result).not.toContain("pg_hba");
  });

  it("разные вызовы могут задать разный fallback для одной и той же неизвестной ошибки", () => {
    const raw = { code: "40001" };
    expect(toAdminActionMessage(raw, "Не удалось сохранить услугу.")).toBe(
      "Не удалось сохранить услугу."
    );
    expect(toAdminActionMessage(raw, "Не удалось удалить интервал.")).toBe(
      "Не удалось удалить интервал."
    );
  });
});
