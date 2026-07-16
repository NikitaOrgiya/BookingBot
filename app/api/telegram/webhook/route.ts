import { getEnv } from "@/lib/env";
import { getBot } from "@/lib/telegram/bot";
import { createTelegramWebhookHandler } from "@/lib/telegram/webhook-handler";

/**
 * Тонкий Route Handler: вся логика — в lib/telegram/{bot,webhook-handler}.ts
 * (тестируемые модули без прямой зависимости от Next.js). Экспортируется
 * только POST — Next.js сам вернёт 405 для любого другого HTTP-метода,
 * запросы к этому route не должны обрабатываться иначе.
 */
export async function POST(request: Request): Promise<Response> {
  const env = getEnv();
  const handler = createTelegramWebhookHandler(getBot(), env.TELEGRAM_WEBHOOK_SECRET);
  return handler(request);
}
