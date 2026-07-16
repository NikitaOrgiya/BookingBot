import "server-only";
import { getServiceSupabaseClient } from "@/lib/supabase/server-client";

/**
 * business_settings.timezone (не переменная окружения BUSINESS_TIMEZONE —
 * та была удалена из lib/env.ts на Этапе 3, потому что уже была мёртвой:
 * все SQL-функции бронирования Этапа 2 и supabase/seed.sql читают/пишут
 * часовой пояс только в этой таблице. Бот делает то же самое, чтобы не
 * заводить второй, потенциально расходящийся источник истины — иначе
 * администратор мог бы сменить часовой пояс через будущую админ-панель, а
 * бот продолжил бы форматировать даты по старому значению из env.
 */
export interface BusinessSettingsSummary {
  timezone: string;
  bookingHorizonDays: number;
}

interface BusinessSettingsRow {
  timezone: string;
  booking_horizon_days: number;
}

export async function getBusinessSettings(): Promise<BusinessSettingsSummary> {
  const supabase = getServiceSupabaseClient();
  const { data, error } = await supabase
    .from("business_settings")
    .select("timezone, booking_horizon_days")
    .eq("id", 1)
    .single<BusinessSettingsRow>();

  if (error || !data) {
    throw new Error(
      `Не удалось прочитать business_settings: ${error?.message ?? "пустой результат"}`,
      { cause: error }
    );
  }

  return {
    timezone: data.timezone,
    bookingHorizonDays: data.booking_horizon_days,
  };
}
