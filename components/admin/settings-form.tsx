"use client";

import { useActionState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { updateBusinessSettings } from "@/app/admin/settings/actions";

export interface SettingsFormValue {
  businessName: string;
  timezone: string;
  bookingHorizonDays: number;
  minBookingNoticeMinutes: number;
  cancellationNoticeMinutes: number;
  slotStepMinutes: number;
  reminderFirstMinutes: number | null;
  reminderSecondMinutes: number | null;
}

const inputClass =
  "rounded-md border border-zinc-300 px-3 py-2 text-sm text-zinc-950 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-50";

export function SettingsForm({ settings }: { settings: SettingsFormValue }) {
  const [state, formAction, isPending] = useActionState(updateBusinessSettings, null);
  const router = useRouter();

  useEffect(() => {
    if (state?.ok) {
      router.refresh();
    }
  }, [state, router]);

  return (
    <form action={formAction} className="flex max-w-xl flex-col gap-5">
      <label className="flex flex-col gap-1 text-sm">
        <span className="font-medium text-zinc-700 dark:text-zinc-300">Название организации</span>
        <input
          type="text"
          name="businessName"
          required
          defaultValue={settings.businessName}
          className={inputClass}
        />
      </label>

      <label className="flex flex-col gap-1 text-sm">
        <span className="font-medium text-zinc-700 dark:text-zinc-300">
          Часовой пояс (текущий: {settings.timezone})
        </span>
        <input
          type="text"
          name="timezone"
          required
          placeholder="Europe/Moscow"
          defaultValue={settings.timezone}
          className={inputClass}
        />
        <span className="text-xs text-zinc-500 dark:text-zinc-400">
          Настоящий IANA-идентификатор (например, Europe/Moscow, Asia/Tbilisi). Изменение влияет
          на отображаемое локальное время уже существующих записей — абсолютный момент времени
          (timestamptz) не меняется, но «9:00» может стать «11:00» и наоборот.
        </span>
      </label>

      <label className="flex items-start gap-2 text-sm">
        <input type="checkbox" name="confirmTimezoneChange" className="mt-1 h-4 w-4" />
        <span className="text-zinc-700 dark:text-zinc-300">
          Подтверждаю: если часовой пояс выше отличается от текущего, я понимаю, что изменится
          отображаемое локальное время существующих записей (обязательно только при реальном
          изменении).
        </span>
      </label>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium text-zinc-700 dark:text-zinc-300">
            Горизонт бронирования (дней)
          </span>
          <input
            type="number"
            name="bookingHorizonDays"
            min={1}
            max={180}
            required
            defaultValue={settings.bookingHorizonDays}
            className={inputClass}
          />
        </label>

        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium text-zinc-700 dark:text-zinc-300">
            Шаг сетки слотов (мин)
          </span>
          <input
            type="number"
            name="slotStepMinutes"
            min={5}
            max={120}
            required
            defaultValue={settings.slotStepMinutes}
            className={inputClass}
          />
        </label>

        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium text-zinc-700 dark:text-zinc-300">
            Мин. уведомление до записи (мин)
          </span>
          <input
            type="number"
            name="minBookingNoticeMinutes"
            min={0}
            required
            defaultValue={settings.minBookingNoticeMinutes}
            className={inputClass}
          />
        </label>

        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium text-zinc-700 dark:text-zinc-300">
            Срок самостоятельной отмены (мин)
          </span>
          <input
            type="number"
            name="cancellationNoticeMinutes"
            min={0}
            required
            defaultValue={settings.cancellationNoticeMinutes}
            className={inputClass}
          />
        </label>
      </div>

      <div className="rounded-md border border-dashed border-zinc-300 p-3 dark:border-zinc-700">
        <p className="mb-3 text-xs font-medium text-zinc-500 dark:text-zinc-400">
          Определяют, за сколько минут до записи создаётся напоминание
          (Этап 5). Фактическая отправка в Telegram включится после
          активации cron владельцем проекта.
        </p>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium text-zinc-700 dark:text-zinc-300">
              Первое напоминание (мин до записи)
            </span>
            <input
              type="number"
              name="reminderFirstMinutes"
              min={0}
              defaultValue={settings.reminderFirstMinutes ?? ""}
              className={inputClass}
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium text-zinc-700 dark:text-zinc-300">
              Второе напоминание (мин до записи)
            </span>
            <input
              type="number"
              name="reminderSecondMinutes"
              min={0}
              defaultValue={settings.reminderSecondMinutes ?? ""}
              className={inputClass}
            />
          </label>
        </div>
      </div>

      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={isPending}
          className="self-start rounded-full bg-zinc-950 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-800 disabled:opacity-50 dark:bg-zinc-50 dark:text-zinc-950 dark:hover:bg-zinc-200"
        >
          {isPending ? "Сохранение…" : "Сохранить настройки"}
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
