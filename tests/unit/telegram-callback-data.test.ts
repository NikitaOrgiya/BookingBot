import { describe, expect, it } from "vitest";
import {
  CALLBACK_ACTIONS,
  decodeCallbackData,
  encodeCallbackData,
  type CallbackData,
} from "@/lib/telegram/callback-data";

const SERVICE_ID = "9c858901-8a57-4791-81fe-4c455b099bc9";
const APPOINTMENT_ID = "550e8400-e29b-41d4-a716-446655440000";
const START_AT = "2026-07-20T11:00:00+03:00";
const ISO_DATE = "2026-07-20";

describe("encodeCallbackData / decodeCallbackData: round-trip", () => {
  const cases: CallbackData[] = [
    { action: "book" },
    { action: "svc", serviceId: SERVICE_ID },
    { action: "dtpg", page: 2 },
    { action: "dt", date: ISO_DATE },
    { action: "back_svc" },
    { action: "back_dt" },
    { action: "sl", startAt: START_AT },
    { action: "back_sl" },
    { action: "cf", startAt: START_AT },
    { action: "abort" },
    { action: "myb", page: 0 },
    { action: "ca", appointmentId: APPOINTMENT_ID },
    { action: "cac", appointmentId: APPOINTMENT_ID },
    { action: "cax" },
    { action: "hlp" },
    { action: "menu" },
    { action: "noop" },
  ];

  it.each(cases)("round-trips $action", (data) => {
    const encoded = encodeCallbackData(data);
    expect(decodeCallbackData(encoded)).toEqual(data);
  });

  it("покрывает каждое действие из CALLBACK_ACTIONS хотя бы одним кейсом", () => {
    const covered = new Set(cases.map((c) => c.action));
    for (const action of CALLBACK_ACTIONS) {
      expect(covered.has(action)).toBe(true);
    }
  });

  it("кодирует компактно — в пределах лимита Telegram на 64 байта", () => {
    for (const data of cases) {
      const encoded = encodeCallbackData(data);
      expect(new TextEncoder().encode(encoded).length).toBeLessThanOrEqual(64);
    }
  });
});

describe("decodeCallbackData: устаревшие/подделанные кнопки", () => {
  it("возвращает null для неизвестного action", () => {
    expect(decodeCallbackData("1|totally_unknown_action|")).toBeNull();
  });

  it("возвращает null для некорректного UUID в svc", () => {
    expect(decodeCallbackData("1|svc|not-a-uuid")).toBeNull();
  });

  it("возвращает null для некорректного UUID в ca/cac", () => {
    expect(decodeCallbackData("1|ca|not-a-uuid")).toBeNull();
    expect(decodeCallbackData("1|cac|not-a-uuid")).toBeNull();
  });

  it("возвращает null для некорректной даты в dt", () => {
    expect(decodeCallbackData("1|dt|not-a-date")).toBeNull();
    expect(decodeCallbackData("1|dt|2026-13-40")).toBeNull();
  });

  it("возвращает null для некорректного datetime в sl/cf", () => {
    expect(decodeCallbackData("1|sl|not-a-datetime")).toBeNull();
    expect(decodeCallbackData("1|cf|2026-07-20")).toBeNull(); // дата без времени
  });

  it("возвращает null для неверной версии", () => {
    expect(decodeCallbackData("2|book|")).toBeNull();
    expect(decodeCallbackData("0|book|")).toBeNull();
  });

  it("возвращает null для сломанного формата (не 3 части через |)", () => {
    expect(decodeCallbackData("1|book")).toBeNull();
    expect(decodeCallbackData("book")).toBeNull();
    expect(decodeCallbackData("1|book|extra|parts")).toBeNull();
  });

  it("возвращает null для пустой/не строковой строки", () => {
    expect(decodeCallbackData("")).toBeNull();
    // @ts-expect-error — намеренно передаём не строку, имитируя порченные данные
    expect(decodeCallbackData(null)).toBeNull();
    // @ts-expect-error — намеренно передаём не строку
    expect(decodeCallbackData(undefined)).toBeNull();
  });

  it("отклоняет непустой payload у действий без параметров", () => {
    expect(decodeCallbackData("1|book|unexpected")).toBeNull();
    expect(decodeCallbackData("1|menu|1")).toBeNull();
  });

  it("отклоняет отрицательные и нечисловые номера страниц", () => {
    expect(decodeCallbackData("1|dtpg|-1")).toBeNull();
    expect(decodeCallbackData("1|dtpg|abc")).toBeNull();
    expect(decodeCallbackData("1|myb|abc")).toBeNull();
  });
});

describe("encodeCallbackData: защита от превышения лимита", () => {
  it("бросает исключение, если результат превышает 64 байта", () => {
    // callback_data не публичный ввод — это защита от программной ошибки
    // (например, случайно передали куда-то произвольный длинный текст), а
    // не пользовательский сценарий.
    const hugeAppointmentId = "x".repeat(100);
    expect(() =>
      encodeCallbackData({
        action: "ca",
        appointmentId: hugeAppointmentId as never,
      })
    ).toThrow(/64/);
  });
});
