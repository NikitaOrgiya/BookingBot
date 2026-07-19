import { describe, expect, it, vi } from "vitest";
import { createReminderCronHandler } from "@/lib/reminders/cron-handler";
import type { ReminderRunSummary } from "@/lib/reminders/types";

function makeRequest(headers?: Record<string, string>): Request {
  return new Request("https://example.test/api/cron/reminders", {
    method: "GET",
    headers,
  });
}

const SUMMARY: ReminderRunSummary = { claimed: 3, sent: 2, failed: 1, skipped: 0 };

describe("createReminderCronHandler: авторизация", () => {
  it("отсутствие заголовка Authorization -> 401", async () => {
    const processReminders = vi.fn();
    const handler = createReminderCronHandler({
      expectedSecret: "correct-secret",
      processReminders,
    });

    const response = await handler(makeRequest());

    expect(response.status).toBe(401);
    expect(processReminders).not.toHaveBeenCalled();
  });

  it("неверный Bearer-токен -> 401", async () => {
    const processReminders = vi.fn();
    const handler = createReminderCronHandler({
      expectedSecret: "correct-secret",
      processReminders,
    });

    const response = await handler(
      makeRequest({ authorization: "Bearer wrong-secret" })
    );

    expect(response.status).toBe(401);
    expect(processReminders).not.toHaveBeenCalled();
  });

  it("заголовок без схемы Bearer -> 401", async () => {
    const handler = createReminderCronHandler({
      expectedSecret: "correct-secret",
      processReminders: vi.fn(),
    });

    const response = await handler(
      makeRequest({ authorization: "correct-secret" })
    );
    expect(response.status).toBe(401);
  });

  it("CRON_SECRET не задан в окружении -> fail closed, 401 даже с правильным на вид токеном", async () => {
    const processReminders = vi.fn();
    const handler = createReminderCronHandler({
      expectedSecret: undefined,
      processReminders,
    });

    const response = await handler(
      makeRequest({ authorization: "Bearer anything" })
    );

    expect(response.status).toBe(401);
    expect(processReminders).not.toHaveBeenCalled();
  });

  it("корректный Bearer-токен -> обработка запускается, 200", async () => {
    const processReminders = vi.fn().mockResolvedValue(SUMMARY);
    const handler = createReminderCronHandler({
      expectedSecret: "correct-secret",
      processReminders,
    });

    const response = await handler(
      makeRequest({ authorization: "Bearer correct-secret" })
    );

    expect(response.status).toBe(200);
    expect(processReminders).toHaveBeenCalledTimes(1);
  });
});

describe("createReminderCronHandler: безопасный JSON-ответ", () => {
  it("успешный ответ содержит только success + счётчики", async () => {
    const handler = createReminderCronHandler({
      expectedSecret: "s",
      processReminders: vi.fn().mockResolvedValue(SUMMARY),
    });

    const response = await handler(makeRequest({ authorization: "Bearer s" }));
    const body = await response.json();

    expect(body).toEqual({ success: true, ...SUMMARY });
  });

  it("ответ не кэшируется", async () => {
    const handler = createReminderCronHandler({
      expectedSecret: "s",
      processReminders: vi.fn().mockResolvedValue(SUMMARY),
    });

    const response = await handler(makeRequest({ authorization: "Bearer s" }));
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("внутренняя ошибка обработки -> 500 с безопасным телом, без деталей исключения", async () => {
    const handler = createReminderCronHandler({
      expectedSecret: "s",
      processReminders: vi
        .fn()
        .mockRejectedValue(new Error("secret internal detail: token=abc123")),
    });

    const response = await handler(makeRequest({ authorization: "Bearer s" }));
    const bodyText = await response.text();

    expect(response.status).toBe(500);
    expect(bodyText).not.toContain("secret internal detail");
    expect(bodyText).not.toContain("token=abc123");
  });

  it("ни один ответ (успех/401/500) не содержит chat_id, username, имени клиента или телефона", async () => {
    const handler = createReminderCronHandler({
      expectedSecret: "s",
      processReminders: vi.fn().mockResolvedValue(SUMMARY),
    });

    const responses = await Promise.all([
      handler(makeRequest()),
      handler(makeRequest({ authorization: "Bearer wrong" })),
      handler(makeRequest({ authorization: "Bearer s" })),
    ]);

    for (const response of responses) {
      const text = await response.text();
      for (const marker of ["chat_id", "username", "phone", "first_name", "last_name"]) {
        expect(text.toLowerCase()).not.toContain(marker);
      }
    }
  });
});
