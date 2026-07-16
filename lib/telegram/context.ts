import type { Context } from "grammy";

/**
 * Расширение контекста grammY: внутренние идентификаторы клиента,
 * заполняемые middleware (см. lib/telegram/bot.ts) один раз в начале
 * обработки update, чтобы обработчики не запрашивали их повторно.
 *
 * telegramUserId — внешний Telegram id как строка (см. lib/telegram/
 * user-profile.ts — почему не number). telegramUserRowId — внутренний
 * uuid строки telegram_users, используемый как FK/ключ владения в
 * appointments и в запросах "мои записи".
 *
 * Это НЕ session-плагин grammY: значения вычисляются заново на каждый
 * update из БД (upsert), в памяти между запросами ничего не хранится —
 * serverless-среда не гарантирует переиспользование процесса.
 */
export interface BotContextFlavor {
  telegramUserId: string;
  telegramUserRowId: string;
}

export type BotContext = Context & BotContextFlavor;
