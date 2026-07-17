import type { AppointmentStatus } from "@/lib/booking/types";
import {
  APPOINTMENT_STATUS_LABELS,
  APPOINTMENT_STATUS_SYMBOLS,
} from "@/lib/admin/appointment-status";

const STATUS_STYLES: Record<AppointmentStatus, string> = {
  confirmed:
    "bg-blue-50 text-blue-700 dark:bg-blue-950 dark:text-blue-300",
  completed:
    "bg-green-50 text-green-700 dark:bg-green-950 dark:text-green-300",
  cancelled: "bg-zinc-100 text-zinc-600 dark:bg-zinc-900 dark:text-zinc-400",
  no_show: "bg-amber-50 text-amber-700 dark:bg-amber-950 dark:text-amber-300",
};

/** Статус записи не обозначается только цветом — рядом всегда идёт
 * символ и текстовая метка (доступность для дальтоников/скринридеров). */
export function StatusBadge({ status }: { status: AppointmentStatus }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ${STATUS_STYLES[status]}`}
    >
      <span aria-hidden="true">{APPOINTMENT_STATUS_SYMBOLS[status]}</span>
      {APPOINTMENT_STATUS_LABELS[status]}
    </span>
  );
}
