import type { BotContext } from "./context";
import type { Screen } from "./screens";

/** Команды (/start, /book, ...) всегда отправляют новое сообщение — нет
 * существующего сообщения с кнопками, которое можно было бы редактировать. */
export async function replyWithScreen(ctx: BotContext, screen: Screen): Promise<void> {
  await ctx.reply(screen.text, { reply_markup: screen.keyboard });
}

/**
 * Навигация по инлайн-кнопкам редактирует существующее сообщение — единый
 * эволюционирующий экран вместо нового сообщения на каждый шаг. Если
 * редактирование невозможно (сообщение слишком старое, оригинал удалён,
 * текст не изменился и Telegram вернул "message is not modified") —
 * откатываемся на новое сообщение, чтобы пользователь не застрял.
 */
export async function editWithScreen(ctx: BotContext, screen: Screen): Promise<void> {
  try {
    await ctx.editMessageText(screen.text, { reply_markup: screen.keyboard });
  } catch {
    await ctx.reply(screen.text, { reply_markup: screen.keyboard });
  }
}
