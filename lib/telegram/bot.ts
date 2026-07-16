import "server-only";
import { Bot, type BotConfig } from "grammy";
import type { UserFromGetMe } from "grammy/types";
import { getEnv } from "@/lib/env";
import type { BotContext } from "./context";
import { claimTelegramUpdate, releaseTelegramUpdate } from "./idempotency";
import { extractTelegramUserProfile } from "./user-profile";
import { upsertTelegramUser } from "./repositories/telegram-users";
import {
  handleBook,
  handleCancelCommand,
  handleHelp,
  handleMyBookings,
  handleStart,
  handleUnknownText,
} from "./handlers/commands";
import { handleCallbackQuery } from "./handlers/callbacks";

/**
 * Сборка grammY Bot<BotContext> с полным порядком middleware. Токен и
 * (опционально) botInfo передаются параметрами, а не читаются из env
 * напрямую внутри этого модуля — это позволяет тестам конструировать бота
 * с фиктивным токеном и заранее известным botInfo, не выполняя реальный
 * сетевой вызов getMe() при bot.init() (см. grammY: `new Bot(token,
 * { botInfo })` пропускает getMe, если botInfo передан явно).
 *
 * Порядок middleware важен и специально зафиксирован здесь:
 *
 *   1. idempotency — атомарный claim update_id. Если update уже
 *      обрабатывается параллельно или обработан ранее — сразу выходим,
 *      ничего не делая (Telegram получит успешный ответ от webhook route,
 *      но бизнес-действие не повторится). Если обработка (все следующие
 *      middleware) бросает исключение — claim освобождается, чтобы
 *      повторная доставка того же update_id получила новую попытку, а не
 *      молчаливый "успех" без реального эффекта.
 *   2. chatType("private") — обновления из групп/супергрупп/каналов не
 *      должны запускать сценарий бронирования вообще.
 *   3. профиль клиента — upsert telegram_users и заполнение
 *      ctx.telegramUserId/ctx.telegramUserRowId до входа в любой
 *      обработчик команды/колбэка.
 *   4. команды и callback_query.
 */
export function createBot(
  token: string,
  options?: { botInfo?: UserFromGetMe } & Omit<BotConfig<BotContext>, "botInfo">
): Bot<BotContext> {
  const bot = new Bot<BotContext>(token, options);

  bot.use(async (ctx, next) => {
    const updateId = ctx.update.update_id;
    const claimed = await claimTelegramUpdate(updateId);
    if (!claimed) {
      // Уже обрабатывается параллельно или обработан ранее — повторная
      // доставка того же update_id не должна повторять бизнес-действие.
      return;
    }
    try {
      await next();
    } catch (err) {
      await releaseTelegramUpdate(updateId);
      throw err;
    }
  });

  const privateChatBot = bot.chatType("private");

  privateChatBot.use(async (ctx, next) => {
    const from = ctx.from;
    if (!from) {
      return;
    }
    const profile = extractTelegramUserProfile(from);
    ctx.telegramUserId = profile.telegramUserId;
    ctx.telegramUserRowId = await upsertTelegramUser(profile);
    await next();
  });

  privateChatBot.command("start", handleStart);
  privateChatBot.command("book", handleBook);
  privateChatBot.command("mybookings", handleMyBookings);
  privateChatBot.command("help", handleHelp);
  privateChatBot.command("cancel", handleCancelCommand);

  privateChatBot.on("callback_query:data", handleCallbackQuery);

  privateChatBot.on("message:text", handleUnknownText);

  return bot;
}

/**
 * Синглтон бота для реального рантайма (webhook route), построенный из
 * process.env через getEnv(). Ленивый — не создаётся при импорте модуля,
 * только при первом реальном обращении (например, из webhook route),
 * чтобы не требовать TELEGRAM_BOT_TOKEN в окружениях/тестах, которым бот
 * не нужен.
 */
let cachedBot: Bot<BotContext> | undefined;

export function getBot(): Bot<BotContext> {
  if (!cachedBot) {
    const env = getEnv();
    cachedBot = createBot(env.TELEGRAM_BOT_TOKEN);
  }
  return cachedBot;
}
