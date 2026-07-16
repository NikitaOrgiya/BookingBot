import "server-only";
import { Bot, type BotConfig, type MiddlewareFn } from "grammy";
import type { UserFromGetMe } from "grammy/types";
import { getEnv } from "@/lib/env";
import type { BotContext } from "./context";
import {
  BusyTelegramUpdateError,
  claimTelegramUpdate,
  completeTelegramUpdate,
  releaseTelegramUpdate,
} from "./idempotency";
import { safeErrorCode } from "./safe-error-code";
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
 *   1. idempotency — claim_telegram_update с crash-safe lease (см.
 *      lib/telegram/idempotency.ts и миграцию
 *      20260716140000_processed_telegram_updates_claim_retry.sql).
 *      Три исхода:
 *        - "completed" — update уже полностью обработан ранее, сразу
 *          выходим, ничего не делая (Telegram получит успешный ответ от
 *          webhook route, бизнес-действие не повторяется);
 *        - "busy" — другой воркер прямо сейчас владеет ещё не истёкшим
 *          lease на этот update_id; бросаем BusyTelegramUpdateError, чтобы
 *          webhook-handler.ts ответил Telegram retryable-статусом (503),
 *          а не успехом (иначе Telegram решит, что update обработан, и
 *          перестанет его повторно доставлять до реального завершения);
 *        - "claimed" — обрабатываем; при успехе завершаем через
 *          complete_telegram_update (claim НАВСЕГДА переходит в
 *          'completed'), при обычной (пойманной здесь) ошибке —
 *          освобождаем через release_telegram_update, чтобы следующая
 *          доставка того же update_id могла заявить его заново. Если
 *          процесс будет убит извне (SIGKILL/serverless timeout) до
 *          complete/release — ни один из них не выполнится, но lease
 *          истечёт сам по locked_until, и claim_telegram_update
 *          перезахватит update_id при следующей доставке — этим
 *          принципиально отличается от предыдущей DELETE-модели, где
 *          такой update_id был бы потерян навсегда.
 *   2. chatType("private") — обновления из групп/супергрупп/каналов не
 *      должны запускать сценарий бронирования вообще.
 *   3. профиль клиента — upsert telegram_users и заполнение
 *      ctx.telegramUserId/ctx.telegramUserRowId до входа в любой
 *      обработчик команды/колбэка.
 *   4. команды и callback_query.
 */
/**
 * Idempotency-middleware вынесен в отдельную экспортируемую функцию (а не
 * инлайн внутри createBot), чтобы её можно было юнит-тестировать напрямую
 * (фиктивные ctx/next), не поднимая полноценный grammY Bot и не рискуя
 * реальным сетевым вызовом Telegram API через ctx.reply у обработчиков,
 * которые она оборачивает (см. tests/unit/telegram-bot-idempotency.test.ts).
 */
export function createIdempotencyMiddleware(): MiddlewareFn<BotContext> {
  return async (ctx, next) => {
    const updateId = ctx.update.update_id;
    const claim = await claimTelegramUpdate(updateId);

    if (claim.status === "completed") {
      // Уже полностью обработан ранее — повторная доставка того же
      // update_id не должна повторять бизнес-действие.
      return;
    }
    if (claim.status === "busy") {
      // Другой воркер прямо сейчас владеет ещё не истёкшим lease.
      // webhook-handler.ts обязан превратить это в retryable-ответ (503),
      // а не в успех и не в обычную 500.
      throw new BusyTelegramUpdateError(updateId);
    }

    try {
      await next();
      const completed = await completeTelegramUpdate(updateId, claim.claimToken);
      if (!completed) {
        // claim_token уже не актуален (lease истёк и был перезахвачен
        // другим воркером до того, как этот воркер успел завершить) —
        // бизнес-действие уже реально выполнено этим воркером и отменить
        // его нельзя, поэтому только диагностика, не исключение.
        console.error(
          "[telegram-bot] complete_telegram_update: claim_token уже неактуален",
          { updateId }
        );
      }
    } catch (err) {
      const released = await releaseTelegramUpdate(
        updateId,
        claim.claimToken,
        safeErrorCode(err)
      ).catch((releaseErr: unknown) => {
        console.error("[telegram-bot] release_telegram_update тоже не удался", {
          updateId,
          code: safeErrorCode(releaseErr),
        });
        return false;
      });
      if (!released) {
        console.error(
          "[telegram-bot] release_telegram_update: claim_token уже неактуален или не удался",
          { updateId }
        );
      }
      throw err;
    }
  };
}

export function createBot(
  token: string,
  options?: { botInfo?: UserFromGetMe } & Omit<BotConfig<BotContext>, "botInfo">
): Bot<BotContext> {
  const bot = new Bot<BotContext>(token, options);

  bot.use(createIdempotencyMiddleware());

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
