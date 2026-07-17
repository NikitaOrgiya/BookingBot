import { describe, expect, it } from "vitest";
import { AdminActionError, toAdminError } from "@/lib/admin/errors";

describe("toAdminError: SQLSTATE -> доменный код административных RPC", () => {
  it.each([
    ["42501", "NOT_ADMIN"],
    ["PB009", "APPOINTMENT_NOT_FOUND"],
    ["PB014", "INVALID_STATUS_TRANSITION"],
    ["PB015", "INVALID_BLOCK_RANGE"],
    ["PB016", "SCHEDULE_BLOCK_NOT_FOUND"],
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
