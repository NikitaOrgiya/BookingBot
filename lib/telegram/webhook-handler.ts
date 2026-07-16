import "server-only";
import { webhookCallback, type Bot } from "grammy";
import type { BotContext } from "./context";
import { BusyTelegramUpdateError } from "./idempotency";
import { safeErrorCode } from "./safe-error-code";

/**
 * Собирает web-standard Request/Response обработчик Telegram webhook поверх
 * grammY. Вынесено из route.ts в отдельную функцию, принимающую готовый Bot
 * и секрет параметрами (а не читающую getBot()/getEnv() изнутри), чтобы это
 * можно было протестировать с фиктивным ботом (без реального токена и без
 * реальных запросов к Telegram API) и с произвольным секретом.
 *
 * Используется адаптер "std/http" — единственный адаптер grammY, работающий
 * напрямую с web-standard Request/Response, которые использует Next.js App
 * Router Route Handler (в отличие от адаптера "next-js", рассчитанного на
 * устаревший Pages API req/res).
 *
 * Проверка X-Telegram-Bot-Api-Secret-Token встроена в сам webhookCallback:
 * он сравнивает заголовок с secretToken константным по времени способом
 * (побайтовое XOR-сравнение без короткого замыкания) и возвращает 401 ДО
 * того, как тело запроса будет разобрано как JSON — см.
 * node_modules/grammy/out/convenience/webhook.js (compareSecretToken
 * вызывается раньше `await handler.update`). Отдельная ручная проверка
 * секрета здесь не нужна и не добавляет дополнительной защиты.
 */
export function createTelegramWebhookHandler(
  bot: Bot<BotContext>,
  secretToken: string
): (request: Request) => Promise<Response> {
  const handleUpdate = webhookCallback(bot, "std/http", { secretToken });

  return async function handleTelegramWebhookRequest(
    request: Request
  ): Promise<Response> {
    // Клон нужен только для безопасного логирования при ошибке: основной
    // Request потребляется внутри handleUpdate (req.json()), повторно
    // прочитать тело можно только с независимой копии.
    const loggingClone = request.clone();

    try {
      return await handleUpdate(request);
    } catch (err) {
      const { updateId, updateType } = await safeExtractUpdateInfo(loggingClone);
      // Осознанно логируем ТОЛЬКО update_id, тип update и безопасный
      // внутренний код ошибки — никогда не весь объект update (там могут
      // быть данные клиента: имя, текст сообщения и т.д.) и никогда не
      // сырой текст ошибки БД.
      console.error("[telegram-webhook] Не удалось обработать update", {
        updateId,
        updateType,
        code: safeErrorCode(err),
      });
      // grammY оборачивает любую ошибку middleware в BotError и кладёт
      // исходно брошенное значение в поле .error (см. bot.handleUpdate в
      // node_modules/grammy/out/bot.js) — поэтому BusyTelegramUpdateError
      // нужно искать именно там, а не в самом err.
      const inner = (err as { error?: unknown } | undefined)?.error ?? err;
      if (inner instanceof BusyTelegramUpdateError) {
        // Другой воркер прямо сейчас владеет ещё не истёкшим lease на этот
        // update_id (см. lib/telegram/idempotency.ts). 503, а не 500/200:
        // это не сбой обработки и не "уже обработано" — семантически это
        // "попробуй ещё раз чуть позже", тот же смысл, который Telegram
        // придаёт 5xx (продолжает повторную доставку), но отдельный код,
        // отличимый в логах/метриках от реальных ошибок обработки.
        return new Response(null, { status: 503 });
      }
      // 5xx, а не 200 — Telegram должен повторить доставку этого update_id
      // позже. Crash-safe lease-идемпотентность (claim/complete/release,
      // см. lib/telegram/idempotency.ts) гарантирует, что повтор не
      // продублирует бизнес-действие, если оно уже реально завершилось —
      // ни при обычной ошибке (release снимает lease), ни при аварийном
      // завершении процесса (lease истекает сам по locked_until).
      return new Response(null, { status: 500 });
    }
  };
}

const KNOWN_UPDATE_TYPE_KEYS = [
  "message",
  "edited_message",
  "channel_post",
  "edited_channel_post",
  "business_connection",
  "business_message",
  "edited_business_message",
  "deleted_business_messages",
  "message_reaction",
  "message_reaction_count",
  "inline_query",
  "chosen_inline_result",
  "callback_query",
  "shipping_query",
  "pre_checkout_query",
  "purchased_paid_media",
  "poll",
  "poll_answer",
  "my_chat_member",
  "chat_member",
  "chat_join_request",
  "chat_boost",
  "removed_chat_boost",
] as const;

async function safeExtractUpdateInfo(
  loggingClone: Request
): Promise<{ updateId: number | undefined; updateType: string }> {
  try {
    const update: unknown = await loggingClone.json();
    if (!update || typeof update !== "object") {
      return { updateId: undefined, updateType: "unknown" };
    }
    const record = update as Record<string, unknown>;
    const updateId =
      typeof record.update_id === "number" ? record.update_id : undefined;
    const updateType =
      KNOWN_UPDATE_TYPE_KEYS.find((key) => key in record) ?? "unknown";
    return { updateId, updateType };
  } catch {
    // Тело не удалось разобрать даже для логирования (не JSON и т.п.) —
    // логируем без этих деталей, не бросаем исключение из обработчика ошибок.
    return { updateId: undefined, updateType: "unknown" };
  }
}
