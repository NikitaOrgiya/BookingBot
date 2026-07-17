import Link from "next/link";
import { createAuthServerClient } from "@/lib/supabase/auth-server-client";
import { getAdminBusinessSettings } from "@/lib/admin/business-settings";
import { getBusinessDayBounds, getBusinessWeekBounds } from "@/lib/admin/date-time";
import {
  formatDateForDisplay,
  formatTimeForDisplay,
  toBusinessLocalParts,
} from "@/lib/telegram/formatters";

interface UpcomingRow {
  id: string;
  start_at: string;
  service_name_snapshot: string;
}

async function loadDashboardData() {
  const settings = await getAdminBusinessSettings();
  const supabase = await createAuthServerClient();
  const day = getBusinessDayBounds(settings.timezone);
  const week = getBusinessWeekBounds(settings.timezone);
  const nowIso = new Date().toISOString();

  // Только счётчики (head: true — без строк) и один короткий список
  // ближайших записей: dashboard не должен читать всю таблицу appointments.
  const [todayConfirmed, weekTotal, weekCancelled, upcoming] = await Promise.all([
    supabase
      .from("appointments")
      .select("id", { count: "exact", head: true })
      .eq("status", "confirmed")
      .gte("start_at", day.startIso)
      .lt("start_at", day.endIso),
    supabase
      .from("appointments")
      .select("id", { count: "exact", head: true })
      .gte("start_at", week.startIso)
      .lt("start_at", week.endIso),
    supabase
      .from("appointments")
      .select("id", { count: "exact", head: true })
      .eq("status", "cancelled")
      .gte("start_at", week.startIso)
      .lt("start_at", week.endIso),
    supabase
      .from("appointments")
      .select("id, start_at, service_name_snapshot")
      .eq("status", "confirmed")
      .gt("start_at", nowIso)
      .order("start_at", { ascending: true })
      .limit(5),
  ]);

  return {
    settings,
    todayConfirmedCount: todayConfirmed.count ?? 0,
    weekTotalCount: weekTotal.count ?? 0,
    weekCancelledCount: weekCancelled.count ?? 0,
    upcoming: (upcoming.data ?? []) as UpcomingRow[],
  };
}

function StatCard({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950">
      <p className="text-sm text-zinc-500 dark:text-zinc-400">{label}</p>
      <p className="mt-1 text-2xl font-semibold text-zinc-950 dark:text-zinc-50">{value}</p>
    </div>
  );
}

export default async function AdminDashboardPage() {
  const { settings, todayConfirmedCount, weekTotalCount, weekCancelledCount, upcoming } =
    await loadDashboardData();

  return (
    <div className="flex flex-col gap-8">
      <header>
        <h1 className="text-2xl font-semibold text-zinc-950 dark:text-zinc-50">Dashboard</h1>
        <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
          Часовой пояс организации: {settings.timezone}
        </p>
      </header>

      <section className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <StatCard label="Подтверждённые записи сегодня" value={todayConfirmedCount} />
        <StatCard label="Записей на этой неделе" value={weekTotalCount} />
        <StatCard label="Отменено на этой неделе" value={weekCancelledCount} />
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-semibold text-zinc-950 dark:text-zinc-50">
          Ближайшие записи
        </h2>
        {upcoming.length === 0 ? (
          <p className="rounded-lg border border-dashed border-zinc-300 p-6 text-center text-sm text-zinc-500 dark:border-zinc-700 dark:text-zinc-400">
            Нет предстоящих подтверждённых записей.
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {upcoming.map((appt) => {
              const { date } = toBusinessLocalParts(appt.start_at, settings.timezone);
              return (
                <li
                  key={appt.id}
                  className="flex items-center justify-between rounded-lg border border-zinc-200 bg-white px-4 py-3 text-sm dark:border-zinc-800 dark:bg-zinc-950"
                >
                  <span className="text-zinc-950 dark:text-zinc-50">
                    {appt.service_name_snapshot}
                  </span>
                  <span className="text-zinc-500 dark:text-zinc-400">
                    {formatDateForDisplay(date)},{" "}
                    {formatTimeForDisplay(appt.start_at, settings.timezone)}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section className="flex flex-wrap gap-3">
        <Link
          href="/admin/services"
          className="rounded-full border border-zinc-300 px-4 py-2 text-sm font-medium text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-900"
        >
          Управление услугами
        </Link>
        <Link
          href="/admin/schedule"
          className="rounded-full border border-zinc-300 px-4 py-2 text-sm font-medium text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-900"
        >
          Управление расписанием
        </Link>
      </section>
    </div>
  );
}
