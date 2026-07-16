import type { InlineKeyboard } from "grammy";
import type { AvailableSlot, Appointment } from "@/lib/booking/types";
import {
  backToMenuKeyboard,
  cancelConfirmKeyboard,
  confirmKeyboard,
  datesKeyboard,
  mainMenuKeyboard,
  myBookingsKeyboard,
  servicesKeyboard,
  slotsKeyboard,
  type ServiceOption,
} from "./keyboards";
import { addDaysToDateString, getTodayDateString } from "./formatters";
import {
  formatCancelConfirmPrompt,
  formatConfirmationMessage,
  formatDateListMessage,
  formatMyBookingsMessage,
  formatServiceListMessage,
  formatSlotListMessage,
  HELP_MESSAGE,
  MAIN_MENU_MESSAGE,
  NO_ACTIVE_SERVICES_MESSAGE,
  NO_SLOTS_MESSAGE,
} from "./messages";

/**
 * "Экран" — пара (текст, клавиатура), которую можно либо отправить новым
 * сообщением (команды), либо подставить в editMessageText (навигация по
 * инлайн-кнопкам). Все функции здесь чистые и не обращаются к БД — данные
 * загружают вызывающие обработчики (lib/telegram/handlers/*), экран лишь
 * решает, как их показать. Это также делает экраны тривиально
 * unit-тестируемыми без БД/сети.
 */
export interface Screen {
  text: string;
  keyboard: InlineKeyboard;
}

export function mainMenuScreen(): Screen {
  return { text: MAIN_MENU_MESSAGE, keyboard: mainMenuKeyboard() };
}

export function helpScreen(): Screen {
  return { text: HELP_MESSAGE, keyboard: backToMenuKeyboard() };
}

export function serviceListScreen(services: ServiceOption[]): Screen {
  if (services.length === 0) {
    return { text: NO_ACTIVE_SERVICES_MESSAGE, keyboard: backToMenuKeyboard() };
  }
  return {
    text: formatServiceListMessage(),
    keyboard: servicesKeyboard(services),
  };
}

/** Список дат в пределах горизонта бронирования, начиная с сегодня. */
export function dateListScreen(
  serviceName: string,
  page: number,
  timeZone: string,
  bookingHorizonDays: number
): Screen {
  const today = getTodayDateString(timeZone);
  const dates = Array.from({ length: bookingHorizonDays }, (_, i) =>
    addDaysToDateString(today, i)
  );
  return {
    text: formatDateListMessage(serviceName),
    keyboard: datesKeyboard(dates, page),
  };
}

export function slotListScreen(
  date: string,
  slots: AvailableSlot[],
  timeZone: string
): Screen {
  if (slots.length === 0) {
    return { text: NO_SLOTS_MESSAGE, keyboard: slotsKeyboard([], timeZone) };
  }
  return {
    text: formatSlotListMessage(date),
    keyboard: slotsKeyboard(slots, timeZone),
  };
}

export function confirmScreen(params: {
  serviceName: string;
  durationMinutes: number;
  priceCents: number | null;
  startAtIso: string;
  timeZone: string;
}): Screen {
  return {
    text: formatConfirmationMessage(params),
    keyboard: confirmKeyboard(params.startAtIso),
  };
}

export function myBookingsScreen(
  appointments: Appointment[],
  page: number,
  hasMore: boolean,
  timeZone: string
): Screen {
  return {
    text: formatMyBookingsMessage(appointments, timeZone),
    keyboard: myBookingsKeyboard(
      appointments.map((a) => a.id),
      page,
      hasMore
    ),
  };
}

export function cancelConfirmScreen(
  appointment: Appointment,
  timeZone: string
): Screen {
  return {
    text: formatCancelConfirmPrompt(appointment, timeZone),
    keyboard: cancelConfirmKeyboard(appointment.id),
  };
}
