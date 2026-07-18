"use client";

import { useActionState, useEffect } from "react";
import { useRouter } from "next/navigation";
import type { ScheduleBlockActionState } from "@/app/admin/schedule/actions";
import { formatTimeForDisplay } from "@/lib/telegram/formatters";

export interface ScheduleBlockFormValue {
  id: string;
  localDate: string;
  startTime: string;
  endTime: string;
  reason: string | null;
}

const inputClass =
  "rounded-md border border-zinc-300 px-2 py-1.5 text-sm text-zinc-950 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-50";

type ScheduleBlockAction = (
  prevState: ScheduleBlockActionState | null,
  formData: FormData
) => Promise<ScheduleBlockActionState>;

/**
 * Форма создания/изменения блокировки. Перед фактическим сохранением
 * сервер (см. app/admin/schedule/actions.ts) проверяет пересечение с
 * подтверждёнными будущими записями и, если есть конфликт, возвращает его
 * список вместо сохранения — форма показывает предупреждение и чекбокс
 * "confirmed", повторная отправка с отмеченным чекбоксом сохраняет
 * блокировку, несмотря на конфликт (appointments не отменяются
 * автоматически).
 */
export function ScheduleBlockForm({
  action,
  block,
  timeZone,
  submitLabel = "Создать блокировку",
}: {
  action: ScheduleBlockAction;
  block?: ScheduleBlockFormValue;
  timeZone: string;
  submitLabel?: string;
}) {
  const [state, formAction, isPending] = useActionState(action, null);
  const router = useRouter();

  useEffect(() => {
    if (state?.ok) {
      router.refresh();
    }
  }, [state, router]);

  return (
    <form action={formAction} className="flex flex-col gap-3">
      {block ? <input type="hidden" name="blockId" value={block.id} /> : null}

      <div className="flex flex-wrap gap-3">
        <label className="flex flex-col gap-1 text-xs text-zinc-500 dark:text-zinc-400">
          Дата
          <input
            type="date"
            name="localDate"
            required
            defaultValue={block?.localDate}
            className={inputClass}
          />
        </label>
        <label className="flex flex-col gap-1 text-xs text-zinc-500 dark:text-zinc-400">
          Начало
          <input
            type="time"
            name="startTime"
            required
            defaultValue={block?.startTime ?? "00:00"}
            className={inputClass}
          />
        </label>
        <label className="flex flex-col gap-1 text-xs text-zinc-500 dark:text-zinc-400">
          Окончание
          <input
            type="time"
            name="endTime"
            required
            defaultValue={block?.endTime ?? "23:59"}
            className={inputClass}
          />
        </label>
        <label className="flex flex-1 flex-col gap-1 text-xs text-zinc-500 dark:text-zinc-400">
          Причина (необязательно)
          <input
            type="text"
            name="reason"
            defaultValue={block?.reason ?? ""}
            className={inputClass}
          />
        </label>
      </div>

      <p className="text-xs text-zinc-400 dark:text-zinc-500">
        Время указывается локально, в часовом поясе организации ({timeZone}) — преобразование в
        UTC выполняется на сервере.
      </p>

      {state?.conflicts && state.conflicts.length > 0 ? (
        <div className="flex flex-col gap-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm dark:border-amber-800 dark:bg-amber-950">
          <p className="font-medium text-amber-800 dark:text-amber-300">{state.message}</p>
          <ul className="flex flex-col gap-1 text-amber-700 dark:text-amber-400">
            {state.conflicts.map((conflict) => (
              <li key={conflict.appointmentId}>
                {conflict.serviceName} — {formatTimeForDisplay(conflict.startAt, timeZone)}–
                {formatTimeForDisplay(conflict.endAt, timeZone)}
              </li>
            ))}
          </ul>
          <label className="flex items-center gap-2 font-medium text-amber-800 dark:text-amber-300">
            <input type="checkbox" name="confirmed" required className="h-4 w-4" />
            Всё равно создать блокировку (записи не будут отменены автоматически)
          </label>
        </div>
      ) : null}

      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={isPending}
          className="self-start rounded-full bg-zinc-950 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-800 disabled:opacity-50 dark:bg-zinc-50 dark:text-zinc-950 dark:hover:bg-zinc-200"
        >
          {isPending ? "Сохранение…" : submitLabel}
        </button>
        {state && !state.ok && (!state.conflicts || state.conflicts.length === 0) ? (
          <span role="alert" className="text-sm text-red-600 dark:text-red-400">
            {state.message}
          </span>
        ) : null}
        {state?.ok ? (
          <span className="text-sm text-green-700 dark:text-green-400">{state.message}</span>
        ) : null}
      </div>
    </form>
  );
}
