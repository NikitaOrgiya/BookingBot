import { BookingError, cancelAppointmentByClient, getAvailableSlots, reserveAppointment } from "@/lib/booking";
import type { BookingErrorCode } from "@/lib/booking/errors";
import type { BotContext } from "../context";
import { type CallbackData, decodeCallbackData } from "../callback-data";
import { toBusinessLocalParts } from "../formatters";
import {
  BOOKING_ABORTED_MESSAGE,
  CANCEL_ABORTED_MESSAGE,
  CANCEL_SUCCESS_MESSAGE,
  formatBookingErrorMessage,
  formatBookingSuccessMessage,
  STALE_BUTTON_MESSAGE,
} from "../messages";
import { editWithScreen } from "../respond";
import {
  getOwnAppointmentById,
  listUpcomingAppointments,
  MY_BOOKINGS_PAGE_SIZE,
} from "../repositories/appointments";
import {
  clearBookingSession,
  getBookingSession,
  setBookingSession,
} from "../repositories/booking-sessions";
import { getBusinessSettings } from "../repositories/business-settings";
import { getServiceById, listActiveServices } from "../repositories/services";
import {
  cancelConfirmScreen,
  confirmScreen,
  dateListScreen,
  helpScreen,
  mainMenuScreen,
  myBookingsScreen,
  serviceListScreen,
  slotListScreen,
} from "../screens";

/**
 * Единая точка входа для всех callback_query. Всегда отвечает
 * answerCallbackQuery — даже если разбор не удался или обработчик бросил
 * исключение — иначе кнопка в интерфейсе Telegram виснет с крутящимся
 * индикатором навсегда.
 */
export async function handleCallbackQuery(ctx: BotContext): Promise<void> {
  try {
    const raw = ctx.callbackQuery?.data;
    const data = raw ? decodeCallbackData(raw) : null;

    if (!data) {
      await showStaleButton(ctx);
      return;
    }
    await dispatch(ctx, data);
  } finally {
    await ctx.answerCallbackQuery().catch(() => {
      // Отвечать всё равно нечем, если чат/сообщение уже недоступны —
      // не даём этому уронить обработку update.
    });
  }
}

async function dispatch(ctx: BotContext, data: CallbackData): Promise<void> {
  switch (data.action) {
    case "menu":
      await clearBookingSession(ctx.telegramUserId);
      await editWithScreen(ctx, mainMenuScreen());
      return;
    case "hlp":
      await editWithScreen(ctx, helpScreen());
      return;
    case "noop":
      return;
    case "book":
      await onBook(ctx);
      return;
    case "back_svc":
      await onBackToServices(ctx);
      return;
    case "svc":
      await onServiceSelected(ctx, data.serviceId);
      return;
    case "dtpg":
      await onDatePage(ctx, data.page);
      return;
    case "dt":
      await onDateSelected(ctx, data.date);
      return;
    case "back_dt":
      await onBackToDates(ctx);
      return;
    case "sl":
      await onSlotSelected(ctx, data.startAt);
      return;
    case "back_sl":
      await onBackToSlots(ctx);
      return;
    case "cf":
      await onConfirm(ctx, data.startAt);
      return;
    case "abort":
      await onAbort(ctx);
      return;
    case "myb":
      await onMyBookingsPage(ctx, data.page);
      return;
    case "ca":
      await onCancelRequest(ctx, data.appointmentId);
      return;
    case "cac":
      await onCancelConfirmed(ctx, data.appointmentId);
      return;
    case "cax":
      await onCancelAborted(ctx);
      return;
  }
}

/** Кнопка структурно валидна, но не соответствует текущему состоянию
 * сессии (устарела, из другого/сброшенного сценария) — безопасно
 * сбрасываем сессию и просим начать заново, а не гадаем, что имелось в
 * виду. */
async function showStaleButton(ctx: BotContext): Promise<void> {
  await clearBookingSession(ctx.telegramUserId);
  await editWithScreen(ctx, {
    text: STALE_BUTTON_MESSAGE,
    keyboard: mainMenuScreen().keyboard,
  });
}

async function resetToIdleWithError(
  ctx: BotContext,
  code: BookingErrorCode
): Promise<void> {
  await clearBookingSession(ctx.telegramUserId);
  await editWithScreen(ctx, {
    text: formatBookingErrorMessage(code),
    keyboard: mainMenuScreen().keyboard,
  });
}

async function onBook(ctx: BotContext): Promise<void> {
  const services = await listActiveServices();
  if (services.length > 0) {
    await setBookingSession(ctx.telegramUserId, {
      step: "choosing_service",
      selectedServiceId: null,
      selectedDate: null,
      selectedLocalTime: null,
    });
  }
  await editWithScreen(ctx, serviceListScreen(services));
}

async function onBackToServices(ctx: BotContext): Promise<void> {
  const session = await getBookingSession(ctx.telegramUserId);
  if (session.step !== "choosing_date") {
    await showStaleButton(ctx);
    return;
  }
  await onBook(ctx);
}

async function onServiceSelected(ctx: BotContext, serviceId: string): Promise<void> {
  const session = await getBookingSession(ctx.telegramUserId);
  if (session.step !== "choosing_service") {
    await showStaleButton(ctx);
    return;
  }

  // service_id из callback_data повторно проверяется на сервере: клиент
  // мог тапнуть кнопку услуги, которую администратор только что
  // деактивировал.
  const service = await getServiceById(serviceId);
  if (!service || !service.isActive) {
    const services = await listActiveServices();
    await editWithScreen(ctx, serviceListScreen(services));
    return;
  }

  await setBookingSession(ctx.telegramUserId, {
    step: "choosing_date",
    selectedServiceId: service.id,
    selectedDate: null,
    selectedLocalTime: null,
  });

  const settings = await getBusinessSettings();
  await editWithScreen(
    ctx,
    dateListScreen(service.name, 0, settings.timezone, settings.bookingHorizonDays)
  );
}

async function onDatePage(ctx: BotContext, page: number): Promise<void> {
  const session = await getBookingSession(ctx.telegramUserId);
  if (session.step !== "choosing_date" || !session.selectedServiceId) {
    await showStaleButton(ctx);
    return;
  }
  const service = await getServiceById(session.selectedServiceId);
  if (!service) {
    await resetToIdleWithError(ctx, "SERVICE_NOT_FOUND");
    return;
  }
  const settings = await getBusinessSettings();
  await editWithScreen(
    ctx,
    dateListScreen(service.name, page, settings.timezone, settings.bookingHorizonDays)
  );
}

async function onDateSelected(ctx: BotContext, date: string): Promise<void> {
  const session = await getBookingSession(ctx.telegramUserId);
  if (session.step !== "choosing_date" || !session.selectedServiceId) {
    await showStaleButton(ctx);
    return;
  }

  const settings = await getBusinessSettings();
  try {
    const slots = await getAvailableSlots({
      serviceId: session.selectedServiceId,
      fromDate: date,
      toDate: date,
    });
    await setBookingSession(ctx.telegramUserId, {
      step: "choosing_slot",
      selectedServiceId: session.selectedServiceId,
      selectedDate: date,
      selectedLocalTime: null,
    });
    await editWithScreen(ctx, slotListScreen(date, slots, settings.timezone));
  } catch (err) {
    if (!(err instanceof BookingError)) {
      throw err;
    }
    await resetToIdleWithError(ctx, err.code);
  }
}

async function onBackToDates(ctx: BotContext): Promise<void> {
  const session = await getBookingSession(ctx.telegramUserId);
  if (session.step !== "choosing_slot" || !session.selectedServiceId) {
    await showStaleButton(ctx);
    return;
  }
  const service = await getServiceById(session.selectedServiceId);
  if (!service) {
    await resetToIdleWithError(ctx, "SERVICE_NOT_FOUND");
    return;
  }
  await setBookingSession(ctx.telegramUserId, {
    step: "choosing_date",
    selectedServiceId: session.selectedServiceId,
    selectedDate: null,
    selectedLocalTime: null,
  });
  const settings = await getBusinessSettings();
  await editWithScreen(
    ctx,
    dateListScreen(service.name, 0, settings.timezone, settings.bookingHorizonDays)
  );
}

async function onSlotSelected(ctx: BotContext, startAt: string): Promise<void> {
  const session = await getBookingSession(ctx.telegramUserId);
  if (
    session.step !== "choosing_slot" ||
    !session.selectedServiceId ||
    !session.selectedDate
  ) {
    await showStaleButton(ctx);
    return;
  }

  const settings = await getBusinessSettings();
  const localParts = toBusinessLocalParts(startAt, settings.timezone);
  if (localParts.date !== session.selectedDate) {
    // Слот с другой даты, чем выбрано в сессии — устаревшее сообщение.
    await showStaleButton(ctx);
    return;
  }

  const service = await getServiceById(session.selectedServiceId);
  if (!service) {
    await resetToIdleWithError(ctx, "SERVICE_NOT_FOUND");
    return;
  }

  await setBookingSession(ctx.telegramUserId, {
    step: "confirming",
    selectedServiceId: session.selectedServiceId,
    selectedDate: session.selectedDate,
    selectedLocalTime: localParts.time,
  });

  await editWithScreen(
    ctx,
    confirmScreen({
      serviceName: service.name,
      durationMinutes: service.durationMinutes,
      priceCents: service.priceCents,
      startAtIso: startAt,
      timeZone: settings.timezone,
    })
  );
}

async function onBackToSlots(ctx: BotContext): Promise<void> {
  const session = await getBookingSession(ctx.telegramUserId);
  if (
    session.step !== "confirming" ||
    !session.selectedServiceId ||
    !session.selectedDate
  ) {
    await showStaleButton(ctx);
    return;
  }

  await setBookingSession(ctx.telegramUserId, {
    step: "choosing_slot",
    selectedServiceId: session.selectedServiceId,
    selectedDate: session.selectedDate,
    selectedLocalTime: null,
  });

  const settings = await getBusinessSettings();
  try {
    const slots = await getAvailableSlots({
      serviceId: session.selectedServiceId,
      fromDate: session.selectedDate,
      toDate: session.selectedDate,
    });
    await editWithScreen(
      ctx,
      slotListScreen(session.selectedDate, slots, settings.timezone)
    );
  } catch (err) {
    if (!(err instanceof BookingError)) {
      throw err;
    }
    await resetToIdleWithError(ctx, err.code);
  }
}

/**
 * Подтверждение брони. startAt из callback_data сверяется с тем, что
 * реально сохранено в сессии (selectedDate/selectedLocalTime) — это
 * защита от устаревшей кнопки "Подтвердить" на экране, который относится
 * уже не к текущему выбору (например, пользователь вернулся назад и выбрал
 * другое время в новой вкладке того же чата). service_id никогда не
 * передаётся в callback_data этого шага — берётся только из сессии.
 */
async function onConfirm(ctx: BotContext, startAt: string): Promise<void> {
  const session = await getBookingSession(ctx.telegramUserId);
  if (
    session.step !== "confirming" ||
    !session.selectedServiceId ||
    !session.selectedDate ||
    !session.selectedLocalTime
  ) {
    await showStaleButton(ctx);
    return;
  }

  const settings = await getBusinessSettings();
  const localParts = toBusinessLocalParts(startAt, settings.timezone);
  if (
    localParts.date !== session.selectedDate ||
    localParts.time !== session.selectedLocalTime
  ) {
    await showStaleButton(ctx);
    return;
  }

  try {
    const appointment = await reserveAppointment({
      telegramUserId: ctx.telegramUserId,
      serviceId: session.selectedServiceId,
      startAt,
    });
    await clearBookingSession(ctx.telegramUserId);
    await editWithScreen(ctx, {
      text: formatBookingSuccessMessage(appointment, settings.timezone),
      keyboard: mainMenuScreen().keyboard,
    });
  } catch (err) {
    if (!(err instanceof BookingError)) {
      throw err;
    }

    if (err.code === "SLOT_TAKEN") {
      // Показываем актуальные слоты заново, а не просто ошибку — ровно то,
      // что требует сценарий.
      await setBookingSession(ctx.telegramUserId, {
        step: "choosing_slot",
        selectedServiceId: session.selectedServiceId,
        selectedDate: session.selectedDate,
        selectedLocalTime: null,
      });
      const slots = await getAvailableSlots({
        serviceId: session.selectedServiceId,
        fromDate: session.selectedDate,
        toDate: session.selectedDate,
      });
      const slotScreen = slotListScreen(session.selectedDate, slots, settings.timezone);
      await editWithScreen(ctx, {
        text: `${formatBookingErrorMessage("SLOT_TAKEN")}\n\n${slotScreen.text}`,
        keyboard: slotScreen.keyboard,
      });
      return;
    }

    await resetToIdleWithError(ctx, err.code);
  }
}

async function onAbort(ctx: BotContext): Promise<void> {
  await clearBookingSession(ctx.telegramUserId);
  await editWithScreen(ctx, {
    text: BOOKING_ABORTED_MESSAGE,
    keyboard: mainMenuScreen().keyboard,
  });
}

async function onMyBookingsPage(ctx: BotContext, page: number): Promise<void> {
  const settings = await getBusinessSettings();
  const { appointments, hasMore } = await listUpcomingAppointments(
    ctx.telegramUserRowId,
    { limit: MY_BOOKINGS_PAGE_SIZE, offset: page * MY_BOOKINGS_PAGE_SIZE }
  );
  await editWithScreen(
    ctx,
    myBookingsScreen(appointments, page, hasMore, settings.timezone)
  );
}

async function onCancelRequest(ctx: BotContext, appointmentId: string): Promise<void> {
  // Владение проверяется прямо в запросе (см. репозиторий): чужой/
  // несуществующий id даёт null неотличимо друг от друга.
  const appointment = await getOwnAppointmentById(
    ctx.telegramUserRowId,
    appointmentId
  );
  if (!appointment) {
    await onMyBookingsPage(ctx, 0);
    return;
  }
  const settings = await getBusinessSettings();
  await editWithScreen(ctx, cancelConfirmScreen(appointment, settings.timezone));
}

async function onCancelConfirmed(ctx: BotContext, appointmentId: string): Promise<void> {
  try {
    await cancelAppointmentByClient({
      appointmentId,
      telegramUserId: ctx.telegramUserId,
    });
    await editWithScreen(ctx, {
      text: CANCEL_SUCCESS_MESSAGE,
      keyboard: mainMenuScreen().keyboard,
    });
  } catch (err) {
    if (!(err instanceof BookingError)) {
      throw err;
    }
    await editWithScreen(ctx, {
      text: formatBookingErrorMessage(err.code),
      keyboard: mainMenuScreen().keyboard,
    });
  }
}

async function onCancelAborted(ctx: BotContext): Promise<void> {
  const settings = await getBusinessSettings();
  const { appointments, hasMore } = await listUpcomingAppointments(
    ctx.telegramUserRowId,
    { limit: MY_BOOKINGS_PAGE_SIZE, offset: 0 }
  );
  const screen = myBookingsScreen(appointments, 0, hasMore, settings.timezone);
  await editWithScreen(ctx, {
    text: `${CANCEL_ABORTED_MESSAGE}\n\n${screen.text}`,
    keyboard: screen.keyboard,
  });
}
