import { InlineKeyboard } from "grammy";
import type { AvailableSlot } from "@/lib/booking/types";
import { encodeCallbackData } from "./callback-data";
import {
  formatDateForDisplay,
  formatDurationForDisplay,
  formatPriceForDisplay,
  formatTimeForDisplay,
} from "./formatters";

const DATES_PER_PAGE = 8;
const DATES_PER_ROW = 2;
const SLOTS_PER_ROW = 3;

export function mainMenuKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("📅 Записаться", encodeCallbackData({ action: "book" }))
    .row()
    .text("🗓 Мои записи", encodeCallbackData({ action: "myb", page: 0 }))
    .row()
    .text("❓ Помощь", encodeCallbackData({ action: "hlp" }));
}

export interface ServiceOption {
  id: string;
  name: string;
  durationMinutes: number;
  priceCents: number | null;
}

export function servicesKeyboard(services: ServiceOption[]): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  for (const service of services) {
    const label = `${service.name} · ${formatDurationForDisplay(service.durationMinutes)} · ${formatPriceForDisplay(service.priceCents)}`;
    keyboard
      .text(label, encodeCallbackData({ action: "svc", serviceId: service.id }))
      .row();
  }
  keyboard.text("⬅️ В меню", encodeCallbackData({ action: "menu" }));
  return keyboard;
}

/** Постранично разбивает список дат (уже отфильтрованных по горизонту). */
export function datesKeyboard(dates: string[], page: number): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  const start = page * DATES_PER_PAGE;
  const pageDates = dates.slice(start, start + DATES_PER_PAGE);

  for (let i = 0; i < pageDates.length; i += DATES_PER_ROW) {
    const row = pageDates.slice(i, i + DATES_PER_ROW);
    for (const date of row) {
      keyboard.text(
        formatDateForDisplay(date),
        encodeCallbackData({ action: "dt", date })
      );
    }
    keyboard.row();
  }

  const hasPrev = page > 0;
  const hasNext = start + DATES_PER_PAGE < dates.length;
  if (hasPrev) {
    keyboard.text("« Раньше", encodeCallbackData({ action: "dtpg", page: page - 1 }));
  }
  if (hasPrev || hasNext) {
    keyboard.text(`${page + 1}`, encodeCallbackData({ action: "noop" }));
  }
  if (hasNext) {
    keyboard.text("Позже »", encodeCallbackData({ action: "dtpg", page: page + 1 }));
  }
  if (hasPrev || hasNext) {
    keyboard.row();
  }
  keyboard.text("⬅️ Назад", encodeCallbackData({ action: "back_svc" }));
  return keyboard;
}

export function slotsKeyboard(
  slots: AvailableSlot[],
  timeZone: string
): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  for (let i = 0; i < slots.length; i += SLOTS_PER_ROW) {
    const row = slots.slice(i, i + SLOTS_PER_ROW);
    for (const slot of row) {
      keyboard.text(
        formatTimeForDisplay(slot.startAt, timeZone),
        encodeCallbackData({ action: "sl", startAt: slot.startAt })
      );
    }
    keyboard.row();
  }
  keyboard.text("⬅️ Назад", encodeCallbackData({ action: "back_dt" }));
  return keyboard;
}

export function confirmKeyboard(startAtIso: string): InlineKeyboard {
  return new InlineKeyboard()
    .text("✅ Подтвердить", encodeCallbackData({ action: "cf", startAt: startAtIso }))
    .row()
    .text("⬅️ Назад", encodeCallbackData({ action: "back_sl" }))
    .row()
    .text("✖️ Отменить", encodeCallbackData({ action: "abort" }));
}

export function myBookingsKeyboard(
  appointmentIds: string[],
  page: number,
  hasMore: boolean
): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  appointmentIds.forEach((id, index) => {
    keyboard
      .text(
        `✖️ Отменить запись ${index + 1}`,
        encodeCallbackData({ action: "ca", appointmentId: id })
      )
      .row();
  });

  const hasPrev = page > 0;
  if (hasPrev) {
    keyboard.text("« Раньше", encodeCallbackData({ action: "myb", page: page - 1 }));
  }
  if (hasMore) {
    keyboard.text("Ещё »", encodeCallbackData({ action: "myb", page: page + 1 }));
  }
  if (hasPrev || hasMore) {
    keyboard.row();
  }
  keyboard.text("⬅️ В меню", encodeCallbackData({ action: "menu" }));
  return keyboard;
}

export function cancelConfirmKeyboard(appointmentId: string): InlineKeyboard {
  return new InlineKeyboard()
    .text("Да, отменить", encodeCallbackData({ action: "cac", appointmentId }))
    .row()
    .text("Нет, оставить", encodeCallbackData({ action: "cax" }));
}

export function backToMenuKeyboard(): InlineKeyboard {
  return new InlineKeyboard().text("⬅️ В меню", encodeCallbackData({ action: "menu" }));
}
