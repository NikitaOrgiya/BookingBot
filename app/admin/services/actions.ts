"use server";

import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/auth/require-admin";
import { createAuthServerClient } from "@/lib/supabase/auth-server-client";
import { rublesToCents, serviceFormSchema } from "@/lib/admin/schemas";
import { toAdminActionMessage } from "@/lib/admin/errors";

export interface ServiceActionState {
  ok: boolean;
  message: string;
}

/**
 * Создание/изменение услуги — обычный INSERT/UPDATE через authenticated
 * SSR-клиент (RLS: services_admin_all + is_admin()). Услуга никогда не
 * удаляется физически — см. setServiceActive ниже и
 * supabase/migrations/20260717090100_services_restrict_delete.sql (DELETE
 * отозван у authenticated на уровне базы, эта форма не предлагает такую
 * кнопку). Изменения не трогают уже существующие appointments —
 * snapshot-поля записи (service_name_snapshot и т.д.) физически не
 * ссылаются на текущее состояние services.
 */
export async function upsertService(
  _prevState: ServiceActionState | null,
  formData: FormData
): Promise<ServiceActionState> {
  await requireAdmin();

  const serviceId = formData.get("serviceId");
  const parsed = serviceFormSchema.safeParse({
    name: formData.get("name"),
    description: formData.get("description") || undefined,
    durationMinutes: formData.get("durationMinutes"),
    priceRubles: formData.get("priceRubles"),
    sortOrder: formData.get("sortOrder"),
    isActive: formData.get("isActive") === "on",
  });

  if (!parsed.success) {
    return {
      ok: false,
      message: parsed.error.issues[0]?.message ?? "Некорректные данные формы.",
    };
  }

  const supabase = await createAuthServerClient();
  const payload = {
    name: parsed.data.name,
    description: parsed.data.description ?? null,
    duration_minutes: parsed.data.durationMinutes,
    price_cents: rublesToCents(parsed.data.priceRubles),
    sort_order: parsed.data.sortOrder,
    is_active: parsed.data.isActive,
  };

  const isEdit = typeof serviceId === "string" && serviceId.length > 0;
  const { error } = isEdit
    ? await supabase.from("services").update(payload).eq("id", serviceId)
    : await supabase.from("services").insert(payload);

  if (error) {
    return { ok: false, message: toAdminActionMessage(error, "Не удалось сохранить услугу.") };
  }

  revalidatePath("/admin/services");
  return { ok: true, message: isEdit ? "Услуга обновлена." : "Услуга создана." };
}

/** Активировать/деактивировать — единственный способ "убрать" услугу.
 * Физическое удаление не реализовано (DELETE отозван у authenticated в
 * базе), поэтому эта функция не может обойти ограничение и не пытается. */
export async function setServiceActive(
  serviceId: string,
  isActive: boolean
): Promise<ServiceActionState> {
  await requireAdmin();
  const supabase = await createAuthServerClient();
  const { error } = await supabase
    .from("services")
    .update({ is_active: isActive })
    .eq("id", serviceId);

  if (error) {
    return { ok: false, message: toAdminActionMessage(error, "Не удалось изменить активность услуги.") };
  }

  revalidatePath("/admin/services");
  return {
    ok: true,
    message: isActive ? "Услуга активирована." : "Услуга деактивирована.",
  };
}
