"use server";

import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/auth/require-admin";
import { createAuthServerClient } from "@/lib/supabase/auth-server-client";
import { businessSettingsFormSchema } from "@/lib/admin/schemas";
import { toAdminActionMessage } from "@/lib/admin/errors";

export interface SettingsActionState {
  ok: boolean;
  message: string;
}

/**
 * Изменение business_settings — единственной строки-синглтона, которую
 * читают и Telegram-бот, и ядро бронирования (business_settings.timezone
 * и т.д., см. supabase/migrations/20260716100300_business_settings.sql и
 * последующие). CHECK-ограничения БД (booking_horizon 1-180,
 * неотрицательные сроки, slot_step 5-120, непустое имя, настоящий IANA
 * timezone — см. 20260717090300_business_settings_validation.sql) —
 * последнее слово; Zod-схема здесь дублирует их только ради мгновенной
 * обратной связи в форме.
 */
export async function updateBusinessSettings(
  _prevState: SettingsActionState | null,
  formData: FormData
): Promise<SettingsActionState> {
  await requireAdmin();

  const parsed = businessSettingsFormSchema.safeParse({
    businessName: formData.get("businessName"),
    timezone: formData.get("timezone"),
    bookingHorizonDays: formData.get("bookingHorizonDays"),
    minBookingNoticeMinutes: formData.get("minBookingNoticeMinutes"),
    cancellationNoticeMinutes: formData.get("cancellationNoticeMinutes"),
    slotStepMinutes: formData.get("slotStepMinutes"),
    reminderFirstMinutes: formData.get("reminderFirstMinutes") || null,
    reminderSecondMinutes: formData.get("reminderSecondMinutes") || null,
    confirmTimezoneChange: formData.get("confirmTimezoneChange") === "on",
  });

  if (!parsed.success) {
    return {
      ok: false,
      message: parsed.error.issues[0]?.message ?? "Некорректные данные формы.",
    };
  }

  const supabase = await createAuthServerClient();

  const { data: current, error: currentError } = await supabase
    .from("business_settings")
    .select("timezone")
    .eq("id", 1)
    .single<{ timezone: string }>();

  if (currentError || !current) {
    if (currentError) {
      console.error("[admin] Не удалось прочитать business_settings:", currentError);
    }
    return { ok: false, message: "Не удалось прочитать текущие настройки." };
  }

  // Смена часового пояса требует отдельного явного подтверждения:
  // существующие timestamptz-записи сохраняют абсолютный момент времени,
  // но их ОТОБРАЖАЕМОЕ локальное время (и то, что бот считает "сегодня"/
  // "эта неделя") изменится.
  if (current.timezone !== parsed.data.timezone && !parsed.data.confirmTimezoneChange) {
    return {
      ok: false,
      message:
        "Вы меняете часовой пояс организации. Отметьте подтверждение ниже: существующие записи сохранят тот же момент времени, но их отображаемое локальное время изменится.",
    };
  }

  const { error } = await supabase
    .from("business_settings")
    .update({
      business_name: parsed.data.businessName,
      timezone: parsed.data.timezone,
      booking_horizon_days: parsed.data.bookingHorizonDays,
      min_booking_notice_minutes: parsed.data.minBookingNoticeMinutes,
      cancellation_notice_minutes: parsed.data.cancellationNoticeMinutes,
      slot_step_minutes: parsed.data.slotStepMinutes,
      reminder_first_minutes: parsed.data.reminderFirstMinutes,
      reminder_second_minutes: parsed.data.reminderSecondMinutes,
    })
    .eq("id", 1);

  if (error) {
    return { ok: false, message: toAdminActionMessage(error, "Не удалось сохранить настройки.") };
  }

  revalidatePath("/admin/settings");
  revalidatePath("/admin");
  revalidatePath("/admin/schedule");
  return { ok: true, message: "Настройки сохранены." };
}
