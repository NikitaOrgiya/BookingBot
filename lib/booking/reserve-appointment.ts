import "server-only";
import { getServiceSupabaseClient } from "@/lib/supabase/server-client";
import {
  reserveAppointmentInputSchema,
  type ReserveAppointmentInput,
} from "./schemas";
import { toBookingError } from "./errors";
import { mapAppointmentRow, type Appointment, type AppointmentRow } from "./types";

/**
 * Атомарно бронирует слот. Snapshot услуги (имя, длительность, цена) и
 * end_at вычисляются на стороне базы из актуальной услуги — клиентский код
 * их не передаёт и не может подделать. Финальная защита от конкурентного
 * двойного бронирования — exclusion constraint (23P01), который здесь
 * преобразуется в доменный код SLOT_TAKEN.
 *
 * Бросает BookingError с одним из кодов: TELEGRAM_USER_NOT_FOUND,
 * SERVICE_NOT_FOUND, SERVICE_INACTIVE, INVALID_START_TIME,
 * MIN_NOTICE_NOT_MET, OUTSIDE_BOOKING_HORIZON, OUTSIDE_WORKING_HOURS,
 * SCHEDULE_BLOCKED, SLOT_TAKEN, INTERNAL_ERROR.
 */
export async function reserveAppointment(
  input: ReserveAppointmentInput
): Promise<Appointment> {
  const parsed = reserveAppointmentInputSchema.parse(input);
  const supabase = getServiceSupabaseClient();

  const { data, error } = await supabase.rpc("reserve_appointment", {
    p_telegram_user_id: parsed.telegramUserId,
    p_service_id: parsed.serviceId,
    p_start_at: parsed.startAt,
    p_client_note: parsed.clientNote ?? null,
  });

  if (error) {
    throw toBookingError(error);
  }

  if (!data) {
    throw toBookingError(new Error("reserve_appointment вернул пустой результат"));
  }

  return mapAppointmentRow(data as AppointmentRow);
}
