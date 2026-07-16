/**
 * Стабильные типы результатов ядра бронирования. Отделены от «сырых» строк
 * базы: наружу отдаём camelCase-объекты с явными полями, а не то, что
 * вернул PostgREST.
 */

export type AppointmentStatus =
  | "confirmed"
  | "completed"
  | "cancelled"
  | "no_show";

/** Один свободный слот; границы — timestamptz в ISO-8601 (UTC). */
export interface AvailableSlot {
  startAt: string;
  endAt: string;
}

/** Запись на приём (snapshot услуги зафиксирован в момент бронирования). */
export interface Appointment {
  id: string;
  telegramUserRowId: string;
  serviceId: string;
  serviceName: string;
  durationMinutes: number;
  priceCents: number | null;
  startAt: string;
  endAt: string;
  status: AppointmentStatus;
  clientNote: string | null;
  cancelledAt: string | null;
  cancelReason: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Форма строки appointments, как её возвращает PostgREST (snake_case). */
export interface AppointmentRow {
  id: string;
  telegram_user_id: string;
  service_id: string;
  service_name_snapshot: string;
  duration_minutes_snapshot: number;
  price_cents_snapshot: number | null;
  start_at: string;
  end_at: string;
  status: AppointmentStatus;
  client_note: string | null;
  cancelled_at: string | null;
  cancel_reason: string | null;
  created_at: string;
  updated_at: string;
}

export function mapAppointmentRow(row: AppointmentRow): Appointment {
  return {
    id: row.id,
    telegramUserRowId: row.telegram_user_id,
    serviceId: row.service_id,
    serviceName: row.service_name_snapshot,
    durationMinutes: row.duration_minutes_snapshot,
    priceCents: row.price_cents_snapshot,
    startAt: row.start_at,
    endAt: row.end_at,
    status: row.status,
    clientNote: row.client_note,
    cancelledAt: row.cancelled_at,
    cancelReason: row.cancel_reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
