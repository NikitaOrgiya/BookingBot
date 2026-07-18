import "server-only";
import { createAuthServerClient } from "@/lib/supabase/auth-server-client";

/**
 * business_settings через authenticated SSR-клиент (RLS + is_admin()) —
 * НЕ через service-role. Используется несколькими страницами панели
 * (dashboard, appointments, schedule, settings), поэтому вынесено в общий
 * модуль, а не продублировано в каждой.
 */
export interface AdminBusinessSettings {
  businessName: string;
  timezone: string;
  bookingHorizonDays: number;
  minBookingNoticeMinutes: number;
  cancellationNoticeMinutes: number;
  slotStepMinutes: number;
  reminderFirstMinutes: number | null;
  reminderSecondMinutes: number | null;
}

interface BusinessSettingsRow {
  business_name: string;
  timezone: string;
  booking_horizon_days: number;
  min_booking_notice_minutes: number;
  cancellation_notice_minutes: number;
  slot_step_minutes: number;
  reminder_first_minutes: number | null;
  reminder_second_minutes: number | null;
}

function mapRow(row: BusinessSettingsRow): AdminBusinessSettings {
  return {
    businessName: row.business_name,
    timezone: row.timezone,
    bookingHorizonDays: row.booking_horizon_days,
    minBookingNoticeMinutes: row.min_booking_notice_minutes,
    cancellationNoticeMinutes: row.cancellation_notice_minutes,
    slotStepMinutes: row.slot_step_minutes,
    reminderFirstMinutes: row.reminder_first_minutes,
    reminderSecondMinutes: row.reminder_second_minutes,
  };
}

export async function getAdminBusinessSettings(): Promise<AdminBusinessSettings> {
  const supabase = await createAuthServerClient();
  const { data, error } = await supabase
    .from("business_settings")
    .select(
      "business_name, timezone, booking_horizon_days, min_booking_notice_minutes, cancellation_notice_minutes, slot_step_minutes, reminder_first_minutes, reminder_second_minutes"
    )
    .eq("id", 1)
    .single<BusinessSettingsRow>();

  if (error || !data) {
    console.error("[admin] Не удалось прочитать business_settings:", error);
    throw new Error("Не удалось прочитать настройки организации.");
  }

  return mapRow(data);
}
