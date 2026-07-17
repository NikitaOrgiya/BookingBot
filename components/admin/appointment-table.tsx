"use client";

import { useActionState, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import type { AppointmentStatus } from "@/lib/booking/types";
import {
  changeAppointmentStatus,
  type ChangeAppointmentStatusState,
} from "@/app/admin/appointments/actions";
import { isAdminTransitionAllowed } from "@/lib/admin/appointment-status";
import {
  formatDateForDisplay,
  formatDurationForDisplay,
  formatPriceForDisplay,
  formatTimeForDisplay,
  toBusinessLocalParts,
} from "@/lib/telegram/formatters";
import { StatusBadge } from "./status-badge";

export interface AdminAppointmentRow {
  id: string;
  startAt: string;
  serviceName: string;
  durationMinutes: number;
  priceCents: number | null;
  status: AppointmentStatus;
  clientNote: string | null;
  clientName: string;
  telegramUsername: string | null;
  telegramId: string;
}

const STATUS_ACTION_LABELS: Record<string, string> = {
  completed: "Завершить",
  no_show: "Не пришёл",
  cancelled: "Отменить",
};

function StatusActionButton({
  appointmentId,
  targetStatus,
  requireConfirm,
}: {
  appointmentId: string;
  targetStatus: AppointmentStatus;
  requireConfirm?: boolean;
}) {
  const initialState: ChangeAppointmentStatusState | null = null;
  const [state, formAction, isPending] = useActionState(
    changeAppointmentStatus,
    initialState
  );
  const router = useRouter();
  const lastHandledOk = useRef(false);

  useEffect(() => {
    if (state?.ok && !lastHandledOk.current) {
      lastHandledOk.current = true;
      router.refresh();
    }
  }, [state, router]);

  return (
    <form
      action={formAction}
      onSubmit={(event) => {
        if (
          requireConfirm &&
          !window.confirm("Отменить эту запись? Действие нельзя обратить в панели.")
        ) {
          event.preventDefault();
        }
      }}
      className="inline-flex flex-col items-start gap-1"
    >
      <input type="hidden" name="appointmentId" value={appointmentId} />
      <input type="hidden" name="newStatus" value={targetStatus} />
      <button
        type="submit"
        disabled={isPending}
        className="rounded-full border border-zinc-300 px-3 py-1 text-xs font-medium text-zinc-700 hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-900"
      >
        {isPending ? "…" : STATUS_ACTION_LABELS[targetStatus]}
      </button>
      {state && !state.ok ? (
        <span role="alert" className="text-xs text-red-600 dark:text-red-400">
          {state.message}
        </span>
      ) : null}
      {state?.ok ? (
        <span className="text-xs text-green-700 dark:text-green-400">{state.message}</span>
      ) : null}
    </form>
  );
}

export function AppointmentTable({
  rows,
  timeZone,
}: {
  rows: AdminAppointmentRow[];
  timeZone: string;
}) {
  if (rows.length === 0) {
    return (
      <p className="rounded-lg border border-dashed border-zinc-300 p-6 text-center text-sm text-zinc-500 dark:border-zinc-700 dark:text-zinc-400">
        Записей, подходящих под фильтр, не найдено.
      </p>
    );
  }

  return (
    <div className="overflow-x-auto rounded-lg border border-zinc-200 dark:border-zinc-800">
      <table className="w-full min-w-[900px] text-left text-sm">
        <thead className="bg-zinc-50 text-xs uppercase text-zinc-500 dark:bg-zinc-900 dark:text-zinc-400">
          <tr>
            <th className="px-3 py-2 font-medium">Дата и время</th>
            <th className="px-3 py-2 font-medium">Услуга</th>
            <th className="px-3 py-2 font-medium">Длительность</th>
            <th className="px-3 py-2 font-medium">Цена</th>
            <th className="px-3 py-2 font-medium">Клиент</th>
            <th className="px-3 py-2 font-medium">Telegram</th>
            <th className="px-3 py-2 font-medium">Статус</th>
            <th className="px-3 py-2 font-medium">Заметка</th>
            <th className="px-3 py-2 font-medium">Действия</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-zinc-100 dark:divide-zinc-900">
          {rows.map((row) => {
            const { date } = toBusinessLocalParts(row.startAt, timeZone);
            return (
            <tr key={row.id}>
              <td className="px-3 py-2 whitespace-nowrap text-zinc-950 dark:text-zinc-50">
                {formatDateForDisplay(date)}
                <br />
                {formatTimeForDisplay(row.startAt, timeZone)}
              </td>
              <td className="px-3 py-2 text-zinc-950 dark:text-zinc-50">{row.serviceName}</td>
              <td className="px-3 py-2 text-zinc-500 dark:text-zinc-400">
                {formatDurationForDisplay(row.durationMinutes)}
              </td>
              <td className="px-3 py-2 text-zinc-500 dark:text-zinc-400">
                {formatPriceForDisplay(row.priceCents)}
              </td>
              <td className="px-3 py-2 text-zinc-950 dark:text-zinc-50">{row.clientName}</td>
              <td className="px-3 py-2 text-zinc-500 dark:text-zinc-400">
                {row.telegramUsername ? `@${row.telegramUsername}` : "—"}
                <br />
                {row.telegramId}
              </td>
              <td className="px-3 py-2">
                <StatusBadge status={row.status} />
              </td>
              <td className="max-w-[200px] truncate px-3 py-2 text-zinc-500 dark:text-zinc-400">
                {row.clientNote ?? "—"}
              </td>
              <td className="px-3 py-2">
                <div className="flex flex-col gap-1.5">
                  {isAdminTransitionAllowed(row.status, "completed") && (
                    <StatusActionButton appointmentId={row.id} targetStatus="completed" />
                  )}
                  {isAdminTransitionAllowed(row.status, "no_show") && (
                    <StatusActionButton appointmentId={row.id} targetStatus="no_show" />
                  )}
                  {isAdminTransitionAllowed(row.status, "cancelled") && (
                    <StatusActionButton
                      appointmentId={row.id}
                      targetStatus="cancelled"
                      requireConfirm
                    />
                  )}
                </div>
              </td>
            </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
