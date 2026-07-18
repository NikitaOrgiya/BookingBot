import { describe, expect, it } from "vitest";
import { isAdminTransitionAllowed } from "@/lib/admin/appointment-status";
import type { AppointmentStatus } from "@/lib/booking/types";

const ALL_STATUSES: AppointmentStatus[] = [
  "confirmed",
  "completed",
  "cancelled",
  "no_show",
];

describe("isAdminTransitionAllowed: та же матрица, что и admin_change_appointment_status в БД", () => {
  it.each([
    ["confirmed", "completed", true],
    ["confirmed", "cancelled", true],
    ["confirmed", "no_show", true],
    ["confirmed", "confirmed", false],
  ] as const)("%s -> %s: %s", (from, to, expected) => {
    expect(isAdminTransitionAllowed(from, to)).toBe(expected);
  });

  it("из completed/cancelled/no_show нет ни одного разрешённого перехода (нет обратных переходов)", () => {
    for (const from of ["completed", "cancelled", "no_show"] as const) {
      for (const to of ALL_STATUSES) {
        expect(isAdminTransitionAllowed(from, to)).toBe(false);
      }
    }
  });
});
