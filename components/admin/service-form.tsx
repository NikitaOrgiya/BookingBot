"use client";

import { useActionState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { upsertService } from "@/app/admin/services/actions";
import { centsToRubles } from "@/lib/admin/schemas";

export interface ServiceFormValue {
  id: string;
  name: string;
  description: string | null;
  durationMinutes: number;
  priceCents: number | null;
  sortOrder: number;
  isActive: boolean;
}

const inputClass =
  "rounded-md border border-zinc-300 px-3 py-2 text-sm text-zinc-950 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-50";

/** Форма создания/редактирования услуги. Цена вводится в рублях (основная
 * денежная единица) — конвертация в price_cents происходит на сервере
 * (upsertService -> rublesToCents), форма никогда не оперирует копейками
 * напрямую. Кнопки "Удалить" здесь нет и не будет: физическое удаление
 * услуг не реализовано (см. lib/admin/schemas.ts, actions.ts). */
export function ServiceForm({ service }: { service?: ServiceFormValue }) {
  const [state, formAction, isPending] = useActionState(upsertService, null);
  const router = useRouter();

  useEffect(() => {
    if (state?.ok) {
      router.refresh();
    }
  }, [state, router]);

  return (
    <form action={formAction} className="flex flex-col gap-4">
      {service ? <input type="hidden" name="serviceId" value={service.id} /> : null}

      <label className="flex flex-col gap-1 text-sm">
        <span className="font-medium text-zinc-700 dark:text-zinc-300">Название</span>
        <input
          type="text"
          name="name"
          required
          defaultValue={service?.name}
          className={inputClass}
        />
      </label>

      <label className="flex flex-col gap-1 text-sm">
        <span className="font-medium text-zinc-700 dark:text-zinc-300">Описание</span>
        <textarea
          name="description"
          rows={2}
          defaultValue={service?.description ?? ""}
          className={inputClass}
        />
      </label>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium text-zinc-700 dark:text-zinc-300">
            Длительность (мин)
          </span>
          <input
            type="number"
            name="durationMinutes"
            min={5}
            max={480}
            step={1}
            required
            defaultValue={service?.durationMinutes ?? 30}
            className={inputClass}
          />
        </label>

        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium text-zinc-700 dark:text-zinc-300">Цена (₽)</span>
          <input
            type="number"
            name="priceRubles"
            min={0}
            step="0.01"
            required
            defaultValue={
              service ? centsToRubles(service.priceCents ?? 0) : 0
            }
            className={inputClass}
          />
        </label>

        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium text-zinc-700 dark:text-zinc-300">
            Порядок отображения
          </span>
          <input
            type="number"
            name="sortOrder"
            step={1}
            required
            defaultValue={service?.sortOrder ?? 0}
            className={inputClass}
          />
        </label>
      </div>

      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          name="isActive"
          defaultChecked={service?.isActive ?? true}
          className="h-4 w-4"
        />
        <span className="font-medium text-zinc-700 dark:text-zinc-300">Активна</span>
      </label>

      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={isPending}
          className="self-start rounded-full bg-zinc-950 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-800 disabled:opacity-50 dark:bg-zinc-50 dark:text-zinc-950 dark:hover:bg-zinc-200"
        >
          {isPending ? "Сохранение…" : service ? "Сохранить изменения" : "Создать услугу"}
        </button>
        {state && !state.ok ? (
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
