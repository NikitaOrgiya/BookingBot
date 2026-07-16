import "server-only";
import { getServiceSupabaseClient } from "@/lib/supabase/server-client";

export interface ServiceSummary {
  id: string;
  name: string;
  durationMinutes: number;
  priceCents: number | null;
  isActive: boolean;
}

interface ServiceRow {
  id: string;
  name: string;
  duration_minutes: number;
  price_cents: number | null;
  is_active: boolean;
}

function mapServiceRow(row: ServiceRow): ServiceSummary {
  return {
    id: row.id,
    name: row.name,
    durationMinutes: row.duration_minutes,
    priceCents: row.price_cents,
    isActive: row.is_active,
  };
}

/** Активные услуги, в фактическом порядке сортировки схемы (sort_order,
 * затем name как стабильный тай-брейк). */
export async function listActiveServices(): Promise<ServiceSummary[]> {
  const supabase = getServiceSupabaseClient();
  const { data, error } = await supabase
    .from("services")
    .select("id, name, duration_minutes, price_cents, is_active")
    .eq("is_active", true)
    .order("sort_order", { ascending: true })
    .order("name", { ascending: true });

  if (error) {
    throw new Error(`Не удалось получить список услуг: ${error.message}`, {
      cause: error,
    });
  }
  return ((data ?? []) as ServiceRow[]).map(mapServiceRow);
}

/**
 * Услуга по id вне зависимости от активности — используется для повторной
 * проверки на сервере (`service_id` из callback_data никогда не доверяем
 * напрямую) и для отображения деталей на экране подтверждения.
 */
export async function getServiceById(
  serviceId: string
): Promise<ServiceSummary | null> {
  const supabase = getServiceSupabaseClient();
  const { data, error } = await supabase
    .from("services")
    .select("id, name, duration_minutes, price_cents, is_active")
    .eq("id", serviceId)
    .maybeSingle<ServiceRow>();

  if (error) {
    throw new Error(`Не удалось получить услугу: ${error.message}`, {
      cause: error,
    });
  }
  return data ? mapServiceRow(data) : null;
}
