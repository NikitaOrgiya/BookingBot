import "server-only";
import { getServiceSupabaseClient } from "@/lib/supabase/server-client";
import {
  cancelAppointmentInputSchema,
  type CancelAppointmentInput,
} from "./schemas";
import { toBookingError } from "./errors";
import { mapAppointmentRow, type Appointment, type AppointmentRow } from "./types";

/**
 * Отмена записи клиентом. Строка не удаляется: статус переводится в
 * cancelled, проставляется cancelled_at и (при наличии) причина. База
 * проверяет принадлежность записи клиенту и cancellation_notice_minutes.
 *
 * Бросает BookingError с одним из кодов: TELEGRAM_USER_NOT_FOUND,
 * APPOINTMENT_NOT_FOUND, APPOINTMENT_NOT_OWNED, CANCELLATION_TOO_LATE,
 * ALREADY_CANCELLED, INTERNAL_ERROR.
 */
export async function cancelAppointmentByClient(
  input: CancelAppointmentInput
): Promise<Appointment> {
  const parsed = cancelAppointmentInputSchema.parse(input);
  const supabase = getServiceSupabaseClient();

  const { data, error } = await supabase.rpc("cancel_appointment_by_client", {
    p_appointment_id: parsed.appointmentId,
    p_telegram_user_id: parsed.telegramUserId,
    p_reason: parsed.reason ?? null,
  });

  if (error) {
    throw toBookingError(error);
  }

  if (!data) {
    throw toBookingError(
      new Error("cancel_appointment_by_client вернул пустой результат")
    );
  }

  return mapAppointmentRow(data as AppointmentRow);
}
