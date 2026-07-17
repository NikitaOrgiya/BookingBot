"use client";

import { useActionState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { upsertWorkingHour } from "@/app/admin/schedule/actions";

export const WEEKDAY_LABELS = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"];

export interface WorkingHourFormValue {
  id: string;
  weekday: number;
  startTime: string;
  endTime: string;
  isActive: boolean;
}

const inputClass =
  "rounded-md border border-zinc-300 px-2 py-1.5 text-sm text-zinc-950 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-50";

export function WorkingHourForm({
  workingHour,
  defaultWeekday,
}: {
  workingHour?: WorkingHourFormValue;
  defaultWeekday?: number;
}) {
  const [state, formAction, isPending] = useActionState(upsertWorkingHour, null);
  const router = useRouter();

  useEffect(() => {
    if (state?.ok) {
      router.refresh();
    }
  }, [state, router]);

  return (
    <form action={formAction} className="flex flex-wrap items-end gap-3">
      {workingHour ? (
        <input type="hidden" name="workingHourId" value={workingHour.id} />
      ) : null}

      <label className="flex flex-col gap-1 text-xs text-zinc-500 dark:text-zinc-400">
        День недели
        <select
          name="weekday"
          defaultValue={workingHour?.weekday ?? defaultWeekday ?? 0}
          className={inputClass}
        >
          {WEEKDAY_LABELS.map((label, index) => (
            <option key={label} value={index}>
              {label}
            </option>
          ))}
        </select>
      </label>

      <label className="flex flex-col gap-1 text-xs text-zinc-500 dark:text-zinc-400">
        Начало
        <input
          type="time"
          name="startTime"
          required
          defaultValue={workingHour?.startTime ?? "09:00"}
          className={inputClass}
        />
      </label>

      <label className="flex flex-col gap-1 text-xs text-zinc-500 dark:text-zinc-400">
        Окончание
        <input
          type="time"
          name="endTime"
          required
          defaultValue={workingHour?.endTime ?? "18:00"}
          className={inputClass}
        />
      </label>

      <label className="flex items-center gap-1.5 text-xs text-zinc-500 dark:text-zinc-400">
        <input
          type="checkbox"
          name="isActive"
          defaultChecked={workingHour?.isActive ?? true}
          className="h-4 w-4"
        />
        Активен
      </label>

      <button
        type="submit"
        disabled={isPending}
        className="rounded-full bg-zinc-950 px-4 py-1.5 text-sm font-medium text-white hover:bg-zinc-800 disabled:opacity-50 dark:bg-zinc-50 dark:text-zinc-950 dark:hover:bg-zinc-200"
      >
        {isPending ? "Сохранение…" : workingHour ? "Сохранить" : "Добавить интервал"}
      </button>

      {state && !state.ok ? (
        <span role="alert" className="w-full text-sm text-red-600 dark:text-red-400">
          {state.message}
        </span>
      ) : null}
      {state?.ok ? (
        <span className="w-full text-sm text-green-700 dark:text-green-400">{state.message}</span>
      ) : null}
    </form>
  );
}
