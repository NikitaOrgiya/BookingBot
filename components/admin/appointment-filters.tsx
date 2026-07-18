import { APPOINTMENT_STATUS_LABELS } from "@/lib/admin/appointment-status";
import type { AppointmentStatus } from "@/lib/booking/types";

export interface AppointmentFiltersValue {
  dateFrom?: string;
  dateTo?: string;
  status?: AppointmentStatus;
  clientName?: string;
  telegramUsername?: string;
  telegramId?: string;
}

const STATUS_OPTIONS: AppointmentStatus[] = [
  "confirmed",
  "completed",
  "cancelled",
  "no_show",
];

const inputClass =
  "rounded-md border border-zinc-300 px-2 py-1.5 text-sm text-zinc-950 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-50";

/** Обычная GET-форма (без JS): фильтры полностью выражаются в query string
 * страницы, поэтому обновление страницы/шаринг ссылки с фильтром работает
 * "из коробки". */
export function AppointmentFilters({ value }: { value: AppointmentFiltersValue }) {
  return (
    <form
      method="get"
      className="flex flex-wrap items-end gap-3 rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950"
    >
      <label className="flex flex-col gap-1 text-xs text-zinc-500 dark:text-zinc-400">
        Дата с
        <input type="date" name="dateFrom" defaultValue={value.dateFrom} className={inputClass} />
      </label>
      <label className="flex flex-col gap-1 text-xs text-zinc-500 dark:text-zinc-400">
        Дата по
        <input type="date" name="dateTo" defaultValue={value.dateTo} className={inputClass} />
      </label>
      <label className="flex flex-col gap-1 text-xs text-zinc-500 dark:text-zinc-400">
        Статус
        <select name="status" defaultValue={value.status ?? ""} className={inputClass}>
          <option value="">Любой</option>
          {STATUS_OPTIONS.map((status) => (
            <option key={status} value={status}>
              {APPOINTMENT_STATUS_LABELS[status]}
            </option>
          ))}
        </select>
      </label>
      <label className="flex flex-col gap-1 text-xs text-zinc-500 dark:text-zinc-400">
        Имя клиента
        <input
          type="text"
          name="clientName"
          defaultValue={value.clientName}
          className={inputClass}
        />
      </label>
      <label className="flex flex-col gap-1 text-xs text-zinc-500 dark:text-zinc-400">
        Telegram username
        <input
          type="text"
          name="telegramUsername"
          defaultValue={value.telegramUsername}
          className={inputClass}
        />
      </label>
      <label className="flex flex-col gap-1 text-xs text-zinc-500 dark:text-zinc-400">
        Telegram ID
        <input
          type="text"
          inputMode="numeric"
          name="telegramId"
          defaultValue={value.telegramId}
          className={inputClass}
        />
      </label>
      <button
        type="submit"
        className="rounded-full bg-zinc-950 px-4 py-1.5 text-sm font-medium text-white hover:bg-zinc-800 dark:bg-zinc-50 dark:text-zinc-950 dark:hover:bg-zinc-200"
      >
        Применить
      </button>
      <a
        href="/admin/appointments"
        className="rounded-full border border-zinc-300 px-4 py-1.5 text-sm font-medium text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-900"
      >
        Сбросить
      </a>
    </form>
  );
}
