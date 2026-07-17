"use server";

import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/auth/require-admin";
import { createAuthServerClient } from "@/lib/supabase/auth-server-client";
import { appointmentStatusChangeSchema } from "@/lib/admin/schemas";
import { toAdminError } from "@/lib/admin/errors";

export interface ChangeAppointmentStatusState {
  ok: boolean;
  message: string;
}

/**
 * Единственный способ, которым панель меняет статус записи — RPC
 * public.admin_change_appointment_status (см.
 * supabase/migrations/20260717090000_...). Панель не создаёт, не удаляет
 * и не редактирует время/клиента/услугу записи — только статус, и только
 * через эту функцию.
 */
export async function changeAppointmentStatus(
  _prevState: ChangeAppointmentStatusState | null,
  formData: FormData
): Promise<ChangeAppointmentStatusState> {
  await requireAdmin();

  const parsed = appointmentStatusChangeSchema.safeParse({
    appointmentId: formData.get("appointmentId"),
    newStatus: formData.get("newStatus"),
    reason: formData.get("reason") || undefined,
  });

  if (!parsed.success) {
    return { ok: false, message: "Некорректные данные формы." };
  }

  const supabase = await createAuthServerClient();
  const { error } = await supabase.rpc("admin_change_appointment_status", {
    p_appointment_id: parsed.data.appointmentId,
    p_new_status: parsed.data.newStatus,
    p_reason: parsed.data.reason ?? null,
  });

  if (error) {
    return { ok: false, message: toAdminError(error).message };
  }

  revalidatePath("/admin/appointments");
  revalidatePath("/admin");
  return { ok: true, message: "Статус записи обновлён." };
}
