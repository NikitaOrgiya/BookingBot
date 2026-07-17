import Link from "next/link";
import { createAuthServerClient } from "@/lib/supabase/auth-server-client";
import { getAdminBusinessSettings } from "@/lib/admin/business-settings";
import { localDateTimeToUtcIso } from "@/lib/admin/date-time";
import { appointmentFilterSchema } from "@/lib/admin/schemas";
import { addDaysToDateString } from "@/lib/telegram/formatters";
import { AppointmentFilters } from "@/components/admin/appointment-filters";
import {
  AppointmentTable,
  type AdminAppointmentRow,
} from "@/components/admin/appointment-table";
import type { AppointmentStatus } from "@/lib/booking/types";

const PAGE_SIZE = 20;

interface AppointmentJoinRow {
  id: string;
  start_at: string;
  service_name_snapshot: string;
  duration_minutes_snapshot: number;
  price_cents_snapshot: number | null;
  status: AppointmentStatus;
  client_note: string | null;
  telegram_users: {
    username: string | null;
    first_name: string | null;
    last_name: string | null;
    telegram_user_id: number | string;
  } | null;
}

function clientDisplayName(row: AppointmentJoinRow["telegram_users"]): string {
  if (!row) {
    return "—";
  }
  const name = [row.first_name, row.last_name].filter(Boolean).join(" ").trim();
  return name || "—";
}

export default async function AdminAppointmentsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const rawParams = await searchParams;
  const parsed = appointmentFilterSchema.safeParse(rawParams);
  const filters = parsed.success
    ? parsed.data
    : appointmentFilterSchema.parse({});

  const settings = await getAdminBusinessSettings();
  const supabase = await createAuthServerClient();

  let query = supabase
    .from("appointments")
    .select(
      "id, start_at, service_name_snapshot, duration_minutes_snapshot, price_cents_snapshot, status, client_note, telegram_users!inner(username, first_name, last_name, telegram_user_id)",
      { count: "exact" }
    );

  if (filters.dateFrom) {
    query = query.gte(
      "start_at",
      localDateTimeToUtcIso(filters.dateFrom, "00:00:00", settings.timezone)
    );
  }
  if (filters.dateTo) {
    query = query.lt(
      "start_at",
      localDateTimeToUtcIso(
        addDaysToDateString(filters.dateTo, 1),
        "00:00:00",
        settings.timezone
      )
    );
  }
  if (filters.status) {
    query = query.eq("status", filters.status);
  }
  if (filters.clientName) {
    const escaped = filters.clientName.replace(/[%_]/g, "\\$&");
    query = query.or(
      `first_name.ilike.%${escaped}%,last_name.ilike.%${escaped}%`,
      { referencedTable: "telegram_users" }
    );
  }
  if (filters.telegramUsername) {
    const escaped = filters.telegramUsername.replace(/[%_]/g, "\\$&");
    query = query.ilike("telegram_users.username", `%${escaped}%`);
  }
  if (filters.telegramId) {
    query = query.eq("telegram_users.telegram_user_id", filters.telegramId);
  }

  const from = (filters.page - 1) * PAGE_SIZE;
  const to = from + PAGE_SIZE - 1;

  const { data, error, count } = await query
    .order("start_at", { ascending: false })
    .range(from, to);

  if (error) {
    throw new Error(`Не удалось получить список записей: ${error.message}`, {
      cause: error,
    });
  }

  const rows: AdminAppointmentRow[] = ((data ?? []) as unknown as AppointmentJoinRow[]).map(
    (row) => ({
      id: row.id,
      startAt: row.start_at,
      serviceName: row.service_name_snapshot,
      durationMinutes: row.duration_minutes_snapshot,
      priceCents: row.price_cents_snapshot,
      status: row.status,
      clientNote: row.client_note,
      clientName: clientDisplayName(row.telegram_users),
      telegramUsername: row.telegram_users?.username ?? null,
      telegramId: String(row.telegram_users?.telegram_user_id ?? ""),
    })
  );

  const total = count ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const buildPageHref = (page: number) => {
    const params = new URLSearchParams();
    if (filters.dateFrom) params.set("dateFrom", filters.dateFrom);
    if (filters.dateTo) params.set("dateTo", filters.dateTo);
    if (filters.status) params.set("status", filters.status);
    if (filters.clientName) params.set("clientName", filters.clientName);
    if (filters.telegramUsername) params.set("telegramUsername", filters.telegramUsername);
    if (filters.telegramId) params.set("telegramId", filters.telegramId);
    params.set("page", String(page));
    return `/admin/appointments?${params.toString()}`;
  };

  return (
    <div className="flex flex-col gap-6">
      <header>
        <h1 className="text-2xl font-semibold text-zinc-950 dark:text-zinc-50">Записи</h1>
        <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
          {total} записей найдено · сортировка по времени (сначала новые)
        </p>
      </header>

      <AppointmentFilters value={filters} />

      <AppointmentTable rows={rows} timeZone={settings.timezone} />

      {totalPages > 1 ? (
        <nav aria-label="Пагинация" className="flex items-center justify-center gap-2 text-sm">
          <Link
            href={buildPageHref(Math.max(1, filters.page - 1))}
            aria-disabled={filters.page <= 1}
            className={`rounded-full border border-zinc-300 px-3 py-1.5 dark:border-zinc-700 ${
              filters.page <= 1 ? "pointer-events-none opacity-40" : "hover:bg-zinc-100 dark:hover:bg-zinc-900"
            }`}
          >
            Назад
          </Link>
          <span className="text-zinc-500 dark:text-zinc-400">
            Страница {filters.page} из {totalPages}
          </span>
          <Link
            href={buildPageHref(Math.min(totalPages, filters.page + 1))}
            aria-disabled={filters.page >= totalPages}
            className={`rounded-full border border-zinc-300 px-3 py-1.5 dark:border-zinc-700 ${
              filters.page >= totalPages ? "pointer-events-none opacity-40" : "hover:bg-zinc-100 dark:hover:bg-zinc-900"
            }`}
          >
            Вперёд
          </Link>
        </nav>
      ) : null}
    </div>
  );
}
