"use server";

import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/auth/require-admin";
import { createAuthServerClient } from "@/lib/supabase/auth-server-client";
import { scheduleBlockFormSchema, workingHourFormSchema } from "@/lib/admin/schemas";
import { toAdminError } from "@/lib/admin/errors";
import type { ActionResult } from "@/components/admin/action-button";

// ---------------------------------------------------------------------
// Недельное расписание (working_hours)
// ---------------------------------------------------------------------

export interface WorkingHourActionState {
  ok: boolean;
  message: string;
}

/** POSTGRES exclusion_violation — интервал пересекается с уже
 * существующим активным интервалом того же дня недели (см.
 * supabase/migrations/20260717090200_working_hours_no_overlap.sql). Это
 * ожидаемый, объяснимый пользователю конфликт, а не внутренняя ошибка. */
const EXCLUSION_VIOLATION = "23P01";

export async function upsertWorkingHour(
  _prevState: WorkingHourActionState | null,
  formData: FormData
): Promise<WorkingHourActionState> {
  await requireAdmin();

  const workingHourId = formData.get("workingHourId");
  const parsed = workingHourFormSchema.safeParse({
    weekday: formData.get("weekday"),
    startTime: formData.get("startTime"),
    endTime: formData.get("endTime"),
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
    weekday: parsed.data.weekday,
    start_time: parsed.data.startTime,
    end_time: parsed.data.endTime,
    is_active: parsed.data.isActive,
  };

  const isEdit = typeof workingHourId === "string" && workingHourId.length > 0;
  const { error } = isEdit
    ? await supabase.from("working_hours").update(payload).eq("id", workingHourId)
    : await supabase.from("working_hours").insert(payload);

  if (error) {
    if (error.code === EXCLUSION_VIOLATION) {
      return {
        ok: false,
        message:
          "Этот интервал пересекается с уже существующим активным интервалом того же дня недели.",
      };
    }
    return { ok: false, message: `Не удалось сохранить интервал: ${error.message}` };
  }

  revalidatePath("/admin/schedule");
  return { ok: true, message: isEdit ? "Интервал обновлён." : "Интервал добавлен." };
}

export async function deleteWorkingHour(id: string): Promise<ActionResult> {
  await requireAdmin();
  const supabase = await createAuthServerClient();
  const { error } = await supabase.from("working_hours").delete().eq("id", id);

  if (error) {
    return { ok: false, message: `Не удалось удалить интервал: ${error.message}` };
  }

  revalidatePath("/admin/schedule");
  return { ok: true, message: "Интервал удалён." };
}

export async function setWorkingHourActive(id: string, isActive: boolean): Promise<ActionResult> {
  await requireAdmin();
  const supabase = await createAuthServerClient();
  const { error } = await supabase
    .from("working_hours")
    .update({ is_active: isActive })
    .eq("id", id);

  if (error) {
    if (error.code === EXCLUSION_VIOLATION) {
      return {
        ok: false,
        message:
          "Нельзя активировать: пересекается с уже существующим активным интервалом того же дня.",
      };
    }
    return { ok: false, message: `Не удалось изменить активность: ${error.message}` };
  }

  revalidatePath("/admin/schedule");
  return { ok: true, message: isActive ? "Интервал активирован." : "Интервал деактивирован." };
}

// ---------------------------------------------------------------------
// Разовые блокировки (schedule_blocks)
// ---------------------------------------------------------------------

export interface ScheduleConflictSummary {
  appointmentId: string;
  startAt: string;
  endAt: string;
  serviceName: string;
}

export interface ScheduleBlockActionState {
  ok: boolean;
  message: string;
  conflicts?: ScheduleConflictSummary[];
}

interface ConflictRow {
  appointment_id: string;
  start_at: string;
  end_at: string;
  service_name: string;
}

async function previewConflicts(
  supabase: Awaited<ReturnType<typeof createAuthServerClient>>,
  localDate: string,
  startTime: string,
  endTime: string
): Promise<ScheduleConflictSummary[]> {
  const { data, error } = await supabase.rpc("admin_preview_schedule_block_conflicts", {
    p_local_date: localDate,
    p_start_time: startTime,
    p_end_time: endTime,
  });

  if (error) {
    throw toAdminError(error);
  }

  return ((data ?? []) as ConflictRow[]).map((row) => ({
    appointmentId: row.appointment_id,
    startAt: row.start_at,
    endAt: row.end_at,
    serviceName: row.service_name,
  }));
}

/**
 * Локальные дата/время преобразуются в timestamptz внутри
 * public.admin_create_schedule_block (читает business_settings.timezone) —
 * этот Server Action НЕ выполняет преобразование часового пояса сам,
 * чтобы timezone браузера/сервера Vercel не могли повлиять на результат.
 *
 * Перед фактическим созданием (если formData не содержит confirmed=true)
 * выполняется предпросмотр пересечений с подтверждёнными будущими
 * записями: при конфликте создание блокируется до явного подтверждения
 * администратором — appointments при этом не отменяются автоматически.
 */
export async function createScheduleBlock(
  _prevState: ScheduleBlockActionState | null,
  formData: FormData
): Promise<ScheduleBlockActionState> {
  await requireAdmin();

  const parsed = scheduleBlockFormSchema.safeParse({
    localDate: formData.get("localDate"),
    startTime: formData.get("startTime"),
    endTime: formData.get("endTime"),
    reason: formData.get("reason") || undefined,
  });

  if (!parsed.success) {
    return {
      ok: false,
      message: parsed.error.issues[0]?.message ?? "Некорректные данные формы.",
    };
  }

  const confirmed = formData.get("confirmed") === "on";
  const supabase = await createAuthServerClient();

  try {
    if (!confirmed) {
      const conflicts = await previewConflicts(
        supabase,
        parsed.data.localDate,
        parsed.data.startTime,
        parsed.data.endTime
      );
      if (conflicts.length > 0) {
        return {
          ok: false,
          message: `Блокировка пересекается с ${conflicts.length} подтверждённой будущей записью. Отметьте подтверждение ниже, чтобы создать блокировку всё равно — записи автоматически не отменяются.`,
          conflicts,
        };
      }
    }

    const { error } = await supabase.rpc("admin_create_schedule_block", {
      p_local_date: parsed.data.localDate,
      p_start_time: parsed.data.startTime,
      p_end_time: parsed.data.endTime,
      p_reason: parsed.data.reason ?? null,
    });

    if (error) {
      return { ok: false, message: toAdminError(error).message };
    }
  } catch (error) {
    return { ok: false, message: toAdminError(error).message };
  }

  revalidatePath("/admin/schedule");
  return { ok: true, message: "Блокировка создана." };
}

export async function updateScheduleBlock(
  _prevState: ScheduleBlockActionState | null,
  formData: FormData
): Promise<ScheduleBlockActionState> {
  await requireAdmin();

  const blockId = formData.get("blockId");
  if (typeof blockId !== "string" || blockId.length === 0) {
    return { ok: false, message: "Некорректный идентификатор блокировки." };
  }

  const parsed = scheduleBlockFormSchema.safeParse({
    localDate: formData.get("localDate"),
    startTime: formData.get("startTime"),
    endTime: formData.get("endTime"),
    reason: formData.get("reason") || undefined,
  });

  if (!parsed.success) {
    return {
      ok: false,
      message: parsed.error.issues[0]?.message ?? "Некорректные данные формы.",
    };
  }

  const confirmed = formData.get("confirmed") === "on";
  const supabase = await createAuthServerClient();

  try {
    if (!confirmed) {
      const conflicts = await previewConflicts(
        supabase,
        parsed.data.localDate,
        parsed.data.startTime,
        parsed.data.endTime
      );
      if (conflicts.length > 0) {
        return {
          ok: false,
          message: `Блокировка пересекается с ${conflicts.length} подтверждённой будущей записью. Отметьте подтверждение ниже, чтобы сохранить всё равно — записи автоматически не отменяются.`,
          conflicts,
        };
      }
    }

    const { error } = await supabase.rpc("admin_update_schedule_block", {
      p_id: blockId,
      p_local_date: parsed.data.localDate,
      p_start_time: parsed.data.startTime,
      p_end_time: parsed.data.endTime,
      p_reason: parsed.data.reason ?? null,
    });

    if (error) {
      return { ok: false, message: toAdminError(error).message };
    }
  } catch (error) {
    return { ok: false, message: toAdminError(error).message };
  }

  revalidatePath("/admin/schedule");
  return { ok: true, message: "Блокировка обновлена." };
}

export async function deleteScheduleBlock(id: string): Promise<ActionResult> {
  await requireAdmin();
  const supabase = await createAuthServerClient();
  const { error } = await supabase.from("schedule_blocks").delete().eq("id", id);

  if (error) {
    return { ok: false, message: `Не удалось удалить блокировку: ${error.message}` };
  }

  revalidatePath("/admin/schedule");
  return { ok: true, message: "Блокировка удалена." };
}
