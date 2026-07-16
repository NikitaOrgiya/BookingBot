import "server-only";
import { getServiceSupabaseClient } from "@/lib/supabase/server-client";
import {
  mapAppointmentRow,
  type Appointment,
  type AppointmentRow,
} from "@/lib/booking/types";

/**
 * Только чтение, отдельное от lib/booking: Этап 2 не предоставляет обёртку
 * для списка своих записей, поэтому здесь — прямой SELECT через тот же
 * server-only привилегированный клиент. Мутации (бронирование, отмена)
 * всегда идут через lib/booking (getAvailableSlots/reserveAppointment/
 * cancelAppointmentByClient), не через этот файл.
 *
 * Владение записью проверяется прямо в WHERE каждого запроса
 * (telegram_user_id = свой внутренний uuid) — так подмена appointmentId в
 * callback_data чужим не может ничего вернуть: запрос просто не найдёт
 * строку. Финальная защита всё равно в cancel_appointment_by_client
 * (APPOINTMENT_NOT_OWNED), это дополнительный, а не единственный рубеж.
 */

export interface ListUpcomingAppointmentsResult {
  appointments: Appointment[];
  hasMore: boolean;
}

/** Безопасный лимит на страницу "мои записи" — небольшое фиксированное
 * число вместо неограниченного списка. */
export const MY_BOOKINGS_PAGE_SIZE = 5;

/**
 * Будущие подтверждённые записи клиента, отсортированные по началу.
 * Возвращает на одну запись больше limit, чтобы определить hasMore без
 * отдельного count-запроса.
 */
export async function listUpcomingAppointments(
  telegramUserRowId: string,
  { limit, offset }: { limit: number; offset: number }
): Promise<ListUpcomingAppointmentsResult> {
  const supabase = getServiceSupabaseClient();

  const { data, error } = await supabase
    .from("appointments")
    .select("*")
    .eq("telegram_user_id", telegramUserRowId)
    .eq("status", "confirmed")
    .gt("start_at", new Date().toISOString())
    .order("start_at", { ascending: true })
    .range(offset, offset + limit);

  if (error) {
    throw new Error(`Не удалось получить список записей: ${error.message}`, {
      cause: error,
    });
  }

  const rows = (data ?? []) as AppointmentRow[];
  const hasMore = rows.length > limit;
  return {
    appointments: rows.slice(0, limit).map(mapAppointmentRow),
    hasMore,
  };
}

/**
 * Одна запись клиента по id — только если она принадлежит именно ему.
 * Возвращает null и для "не существует", и для "существует, но чужая":
 * с точки зрения вызывающего клиента эти два случая неотличимы и не
 * должны быть отличимы (не раскрываем существование чужих записей).
 */
export async function getOwnAppointmentById(
  telegramUserRowId: string,
  appointmentId: string
): Promise<Appointment | null> {
  const supabase = getServiceSupabaseClient();

  const { data, error } = await supabase
    .from("appointments")
    .select("*")
    .eq("id", appointmentId)
    .eq("telegram_user_id", telegramUserRowId)
    .maybeSingle<AppointmentRow>();

  if (error) {
    throw new Error(`Не удалось получить запись: ${error.message}`, {
      cause: error,
    });
  }

  return data ? mapAppointmentRow(data) : null;
}
