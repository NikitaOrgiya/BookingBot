import type { AppointmentStatus } from "@/lib/booking/types";

/**
 * Допустимые переходы статуса записи со стороны администратора — та же
 * матрица, что и в public.admin_change_appointment_status (см.
 * supabase/migrations/20260717090000_admin_change_appointment_status.sql).
 * Дублирование намеренное: база данных — источник истины и всегда
 * перепроверяет переход сама; это только для UI (какие кнопки показывать),
 * а не единственная защита.
 */
export const ADMIN_ALLOWED_TRANSITIONS: Record<AppointmentStatus, AppointmentStatus[]> = {
  confirmed: ["completed", "cancelled", "no_show"],
  completed: [],
  cancelled: [],
  no_show: [],
};

export function isAdminTransitionAllowed(
  from: AppointmentStatus,
  to: AppointmentStatus
): boolean {
  return ADMIN_ALLOWED_TRANSITIONS[from].includes(to);
}

/** Человекочитаемая метка статуса — используется вместе с иконкой/формой,
 * не заменяет её (статус не должен обозначаться только цветом). */
export const APPOINTMENT_STATUS_LABELS: Record<AppointmentStatus, string> = {
  confirmed: "Подтверждена",
  completed: "Завершена",
  cancelled: "Отменена",
  no_show: "Не пришёл",
};

export const APPOINTMENT_STATUS_SYMBOLS: Record<AppointmentStatus, string> = {
  confirmed: "●",
  completed: "✓",
  cancelled: "✕",
  no_show: "!",
};
