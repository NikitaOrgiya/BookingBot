import type { BotContext } from "../context";
import { WELCOME_MESSAGE, NO_ACTIVE_BOOKING_MESSAGE, BOOKING_ABORTED_MESSAGE } from "../messages";
import { mainMenuKeyboard } from "../keyboards";
import {
  clearBookingSession,
  getBookingSession,
  setBookingSession,
} from "../repositories/booking-sessions";
import { listActiveServices } from "../repositories/services";
import { listUpcomingAppointments, MY_BOOKINGS_PAGE_SIZE } from "../repositories/appointments";
import { getBusinessSettings } from "../repositories/business-settings";
import {
  helpScreen,
  mainMenuScreen,
  myBookingsScreen,
  serviceListScreen,
} from "../screens";
import { replyWithScreen } from "../respond";

/** /start — приветствие и главное меню. Не трогает текущую сессию
 * бронирования (для этого есть отдельная команда /cancel). */
export async function handleStart(ctx: BotContext): Promise<void> {
  await ctx.reply(WELCOME_MESSAGE, { reply_markup: mainMenuKeyboard() });
}

/** /book и колбэк "book" — начинает (или начинает заново) сценарий записи. */
export async function handleBook(ctx: BotContext): Promise<void> {
  const services = await listActiveServices();
  if (services.length > 0) {
    await setBookingSession(ctx.telegramUserId, {
      step: "choosing_service",
      selectedServiceId: null,
      selectedDate: null,
      selectedLocalTime: null,
    });
  }
  await replyWithScreen(ctx, serviceListScreen(services));
}

/** /mybookings и колбэк "myb" (командный вход, всегда страница 0). */
export async function handleMyBookings(ctx: BotContext): Promise<void> {
  const settings = await getBusinessSettings();
  const { appointments, hasMore } = await listUpcomingAppointments(
    ctx.telegramUserRowId,
    { limit: MY_BOOKINGS_PAGE_SIZE, offset: 0 }
  );
  await replyWithScreen(
    ctx,
    myBookingsScreen(appointments, 0, hasMore, settings.timezone)
  );
}

/** /help */
export async function handleHelp(ctx: BotContext): Promise<void> {
  await replyWithScreen(ctx, helpScreen());
}

/**
 * /cancel — отменяет ТЕКУЩИЙ незавершённый сценарий бронирования
 * (booking_sessions), а не запись в БД (для этого кнопка "Отменить
 * запись" в /mybookings). Безопасно вызывать, даже если активного
 * сценария нет.
 */
export async function handleCancelCommand(ctx: BotContext): Promise<void> {
  const session = await getBookingSession(ctx.telegramUserId);
  if (session.step === "idle") {
    await ctx.reply(NO_ACTIVE_BOOKING_MESSAGE, { reply_markup: mainMenuKeyboard() });
    return;
  }
  await clearBookingSession(ctx.telegramUserId);
  await ctx.reply(BOOKING_ABORTED_MESSAGE, { reply_markup: mainMenuKeyboard() });
}

/** Нераспознанное текстовое сообщение вне команд — не оставляем клиента
 * без ответа. */
export async function handleUnknownText(ctx: BotContext): Promise<void> {
  await replyWithScreen(ctx, mainMenuScreen());
}
