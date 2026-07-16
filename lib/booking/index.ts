/**
 * Публичная точка входа серверного ядра бронирования.
 *
 * Это СЕРВЕРНЫЙ barrel: он реэкспортирует обёртки, которые тянут
 * "server-only" через привилегированный Supabase-клиент, поэтому импорт
 * этого модуля из клиентского компонента приведёт к ошибке сборки.
 *
 * Клиентскому коду (например, для локализации сообщений) нужны только
 * чистые доменные коды ошибок и типы — их следует импортировать напрямую
 * из "@/lib/booking/errors" и "@/lib/booking/types", а не отсюда.
 */

export { getAvailableSlots } from "./get-available-slots";
export { reserveAppointment } from "./reserve-appointment";
export { cancelAppointmentByClient } from "./cancel-appointment";

export {
  BookingError,
  BOOKING_ERROR_CODES,
  toBookingError,
  sqlstateToBookingCode,
  type BookingErrorCode,
  type PostgresErrorLike,
} from "./errors";

export {
  type Appointment,
  type AppointmentStatus,
  type AvailableSlot,
} from "./types";

export {
  getAvailableSlotsInputSchema,
  reserveAppointmentInputSchema,
  cancelAppointmentInputSchema,
  type GetAvailableSlotsInput,
  type ReserveAppointmentInput,
  type CancelAppointmentInput,
} from "./schemas";
