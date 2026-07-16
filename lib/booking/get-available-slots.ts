import "server-only";
import { getServiceSupabaseClient } from "@/lib/supabase/server-client";
import {
  getAvailableSlotsInputSchema,
  type GetAvailableSlotsInput,
} from "./schemas";
import { toBookingError } from "./errors";
import type { AvailableSlot } from "./types";

interface SlotRow {
  slot_start: string;
  slot_end: string;
}

/**
 * Возвращает свободные слоты активной услуги в окне бронирования.
 * Вся бизнес-логика (расписание, блокировки, занятые слоты, таймзона,
 * горизонт, минимальное уведомление) выполняется атомарно в PostgreSQL-
 * функции public.get_available_slots; здесь — валидация входа, вызов через
 * серверный привилегированный клиент и маппинг результата в стабильный тип.
 *
 * Бросает BookingError (SERVICE_NOT_FOUND / SERVICE_INACTIVE / INTERNAL_ERROR)
 * вместо сырой ошибки базы.
 */
export async function getAvailableSlots(
  input: GetAvailableSlotsInput
): Promise<AvailableSlot[]> {
  const parsed = getAvailableSlotsInputSchema.parse(input);
  const supabase = getServiceSupabaseClient();

  const { data, error } = await supabase.rpc("get_available_slots", {
    p_service_id: parsed.serviceId,
    p_from_date: parsed.fromDate ?? null,
    p_to_date: parsed.toDate ?? null,
  });

  if (error) {
    throw toBookingError(error);
  }

  const rows = (data ?? []) as SlotRow[];
  return rows.map((row) => ({
    startAt: row.slot_start,
    endAt: row.slot_end,
  }));
}
