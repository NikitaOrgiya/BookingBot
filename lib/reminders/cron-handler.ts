import "server-only";
import { timingSafeEqual } from "node:crypto";
import type { ReminderRunSummary } from "./types";

/**
 * Тестируемое ядро GET /api/cron/reminders, вынесенное из route.ts (тот же
 * принцип, что и lib/telegram/webhook-handler.ts для Telegram webhook):
 * зависимости (секрет, функция обработки) передаются параметрами, а не
 * читаются изнутри из process.env/lib/reminders/worker.ts напрямую — это
 * позволяет протестировать проверку Authorization и безопасный формат
 * ответа без реального Supabase/Telegram (см. tests/unit/reminders-cron-handler.test.ts).
 *
 * Секрет сравнивается константным по времени способом — тем же, каким
 * grammY сверяет X-Telegram-Bot-Api-Secret-Token (см. webhook-handler.ts).
 * "fail closed": отсутствующий expectedSecret (CRON_SECRET не задан в
 * окружении) отвечает 401 любому запросу, а не пропускает его.
 */

const DEFAULT_BATCH_SIZE = 20;

function safeCompare(a: string, b: string): boolean {
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  if (aBuf.length !== bBuf.length) {
    // Сравнение того же буфера с самим собой не даёт эту ветку отличить по
    // времени выполнения от случая совпадающей длины.
    timingSafeEqual(aBuf, aBuf);
    return false;
  }
  return timingSafeEqual(aBuf, bBuf);
}

function unauthorized(): Response {
  return Response.json(
    { success: false, error: "UNAUTHORIZED" },
    { status: 401, headers: { "Cache-Control": "no-store" } }
  );
}

export interface ReminderCronHandlerDeps {
  /** process.env.CRON_SECRET — undefined означает "не задан", а не пустую строку. */
  expectedSecret: string | undefined;
  processReminders: (batchSize?: number) => Promise<ReminderRunSummary>;
}

export function createReminderCronHandler(
  deps: ReminderCronHandlerDeps
): (request: Request) => Promise<Response> {
  return async function handleReminderCronRequest(request: Request): Promise<Response> {
    if (!deps.expectedSecret) {
      console.error(
        "[cron/reminders] CRON_SECRET не задан в окружении — доступ отклонён (fail closed)."
      );
      return unauthorized();
    }

    const authHeader = request.headers.get("authorization") ?? "";
    const [scheme, token] = authHeader.split(" ");
    if (scheme !== "Bearer" || !token || !safeCompare(token, deps.expectedSecret)) {
      return unauthorized();
    }

    try {
      const summary = await deps.processReminders(DEFAULT_BATCH_SIZE);
      // Ответ — только счётчики. Никаких chat_id, Telegram username, имени
      // клиента, телефона или текста ошибок с чувствительными деталями.
      return Response.json(
        { success: true, ...summary },
        { headers: { "Cache-Control": "no-store" } }
      );
    } catch (error) {
      console.error("[cron/reminders] Не удалось обработать batch напоминаний:", {
        code: error instanceof Error ? error.name : "UNKNOWN_ERROR",
      });
      return Response.json(
        { success: false, error: "INTERNAL_ERROR" },
        { status: 500, headers: { "Cache-Control": "no-store" } }
      );
    }
  };
}
