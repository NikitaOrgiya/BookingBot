import { describe, expect, it, vi } from "vitest";
import { Bot } from "grammy";
import type { UserFromGetMe } from "grammy/types";
import type { BotContext } from "@/lib/telegram/context";
import { createTelegramWebhookHandler } from "@/lib/telegram/webhook-handler";
import { BusyTelegramUpdateError } from "@/lib/telegram/idempotency";

/**
 * Тесты изолируют createTelegramWebhookHandler от реального lib/telegram/
 * bot.ts (реальной БД/upsert): здесь используется минимальный Bot с
 * фиктивным botInfo (см. new Bot(token, { botInfo }) — пропускает сетевой
 * getMe() при bot.init(), поэтому тест не делает реальных запросов к
 * Telegram API) и без DB-обращающихся middleware. Это проверяет
 * ИМЕННО контракт webhook-обработчика: проверку секрета и безопасное
 * логирование, а не бизнес-логику бота.
 */

const FAKE_BOT_INFO: UserFromGetMe = {
  id: 1,
  is_bot: true,
  first_name: "TestBot",
  username: "test_bot",
  can_join_groups: true,
  can_read_all_group_messages: false,
  supports_inline_queries: false,
  can_connect_to_business: false,
  has_main_web_app: false,
  has_topics_enabled: false,
  allows_users_to_create_topics: false,
  can_manage_bots: false,
  supports_join_request_queries: false,
};

const SECRET = "unit-test-webhook-secret-123";
const SECRET_HEADER = "x-telegram-bot-api-secret-token";

function makeBot(): Bot<BotContext> {
  return new Bot<BotContext>("fake-token-not-real", { botInfo: FAKE_BOT_INFO });
}

function makeUpdateRequest(
  update: Record<string, unknown>,
  headers: Record<string, string> = {}
): Request {
  return new Request("https://example.com/api/telegram/webhook", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(update),
  });
}

function minimalMessageUpdate(overrides: Record<string, unknown> = {}) {
  return {
    update_id: 1,
    message: {
      message_id: 1,
      date: 0,
      chat: { id: 1, type: "private" },
      text: "/start",
    },
    ...overrides,
  };
}

describe("createTelegramWebhookHandler: проверка секрета", () => {
  it("возвращает 401, если заголовок X-Telegram-Bot-Api-Secret-Token отсутствует", async () => {
    const handler = createTelegramWebhookHandler(makeBot(), SECRET);
    const response = await handler(makeUpdateRequest(minimalMessageUpdate()));
    expect(response.status).toBe(401);
  });

  it("возвращает 401, если секрет неверный", async () => {
    const handler = createTelegramWebhookHandler(makeBot(), SECRET);
    const response = await handler(
      makeUpdateRequest(minimalMessageUpdate(), { [SECRET_HEADER]: "wrong-secret" })
    );
    expect(response.status).toBe(401);
  });

  it("не запускает обработку update, если секрет неверный (проверка до обработки payload)", async () => {
    const bot = makeBot();
    let middlewareRan = false;
    bot.on("message", (ctx) => {
      middlewareRan = true;
      return ctx as unknown as void;
    });
    const handler = createTelegramWebhookHandler(bot, SECRET);

    await handler(
      makeUpdateRequest(minimalMessageUpdate(), { [SECRET_HEADER]: "wrong-secret" })
    );

    expect(middlewareRan).toBe(false);
  });

  it("принимает запрос и обрабатывает update, когда секрет верный", async () => {
    const bot = makeBot();
    let receivedUpdateId: number | undefined;
    bot.on("message", (ctx) => {
      receivedUpdateId = ctx.update.update_id;
    });
    const handler = createTelegramWebhookHandler(bot, SECRET);

    const response = await handler(
      makeUpdateRequest(minimalMessageUpdate({ update_id: 777 }), {
        [SECRET_HEADER]: SECRET,
      })
    );

    expect(response.status).toBe(200);
    expect(receivedUpdateId).toBe(777);
  });
});

describe("createTelegramWebhookHandler: безопасное логирование при внутренней ошибке", () => {
  it("возвращает 5xx (Telegram повторит доставку) и логирует только update_id/тип/безопасный код", async () => {
    const bot = makeBot();
    bot.on("message", () => {
      throw new Error("внутренняя ошибка с деталями БД, которые нельзя светить");
    });
    const handler = createTelegramWebhookHandler(bot, SECRET);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const update = minimalMessageUpdate({
      update_id: 555,
      message: {
        message_id: 1,
        date: 0,
        chat: { id: 1, type: "private" },
        text: "секретный текст сообщения клиента",
      },
    });

    const response = await handler(
      makeUpdateRequest(update, { [SECRET_HEADER]: SECRET })
    );

    expect(response.status).toBeGreaterThanOrEqual(500);
    expect(errorSpy).toHaveBeenCalledTimes(1);

    const loggedArgs = errorSpy.mock.calls[0];
    const loggedPayload = loggedArgs[loggedArgs.length - 1];
    expect(loggedPayload).toMatchObject({ updateId: 555, updateType: "message" });

    const fullLogText = JSON.stringify(loggedArgs);
    expect(fullLogText).not.toContain("секретный текст сообщения клиента");
    expect(fullLogText).not.toContain("внутренняя ошибка с деталями БД");

    errorSpy.mockRestore();
  });

  it("никогда не включает токен бота в возвращаемый ответ", async () => {
    const bot = makeBot();
    bot.on("message", () => {
      throw new Error("boom");
    });
    const handler = createTelegramWebhookHandler(bot, SECRET);
    vi.spyOn(console, "error").mockImplementation(() => {});

    const response = await handler(
      makeUpdateRequest(minimalMessageUpdate(), { [SECRET_HEADER]: SECRET })
    );
    const text = await response.text();
    expect(text).not.toContain("fake-token-not-real");

    vi.restoreAllMocks();
  });
});

describe("createTelegramWebhookHandler: retryable-статус при занятом claim (BusyTelegramUpdateError)", () => {
  it("возвращает 503, а не 500/200, когда middleware сигнализирует busy-claim", async () => {
    const bot = makeBot();
    bot.on("message", (ctx) => {
      throw new BusyTelegramUpdateError(ctx.update.update_id);
    });
    const handler = createTelegramWebhookHandler(bot, SECRET);
    vi.spyOn(console, "error").mockImplementation(() => {});

    const response = await handler(
      makeUpdateRequest(minimalMessageUpdate({ update_id: 999 }), {
        [SECRET_HEADER]: SECRET,
      })
    );

    expect(response.status).toBe(503);

    vi.restoreAllMocks();
  });
});
