import { createAuthServerClient } from "@/lib/supabase/auth-server-client";
import { formatDurationForDisplay, formatPriceForDisplay } from "@/lib/telegram/formatters";
import { ServiceForm } from "@/components/admin/service-form";
import { ServiceActiveToggle } from "@/components/admin/service-active-toggle";

interface ServiceRow {
  id: string;
  name: string;
  description: string | null;
  duration_minutes: number;
  price_cents: number | null;
  is_active: boolean;
  sort_order: number;
}

async function loadServices(): Promise<ServiceRow[]> {
  const supabase = await createAuthServerClient();
  const { data, error } = await supabase
    .from("services")
    .select("id, name, description, duration_minutes, price_cents, is_active, sort_order")
    .order("sort_order", { ascending: true })
    .order("name", { ascending: true });

  if (error) {
    throw new Error(`Не удалось получить список услуг: ${error.message}`, {
      cause: error,
    });
  }

  return (data ?? []) as ServiceRow[];
}

export default async function AdminServicesPage() {
  const services = await loadServices();

  return (
    <div className="flex flex-col gap-6">
      <header>
        <h1 className="text-2xl font-semibold text-zinc-950 dark:text-zinc-50">Услуги</h1>
        <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
          {services.length} услуг в каталоге. Физическое удаление не предусмотрено — только
          активация/деактивация: история записей ссылается на услугу и не должна ломаться.
        </p>
      </header>

      <details className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950">
        <summary className="cursor-pointer text-sm font-medium text-zinc-950 dark:text-zinc-50">
          Добавить услугу
        </summary>
        <div className="mt-4">
          <ServiceForm />
        </div>
      </details>

      {services.length === 0 ? (
        <p className="rounded-lg border border-dashed border-zinc-300 p-6 text-center text-sm text-zinc-500 dark:border-zinc-700 dark:text-zinc-400">
          Каталог услуг пуст.
        </p>
      ) : (
        <ul className="flex flex-col gap-3">
          {services.map((service) => (
            <li
              key={service.id}
              className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950"
            >
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-zinc-950 dark:text-zinc-50">
                      {service.name}
                    </span>
                    <span
                      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${
                        service.is_active
                          ? "bg-green-50 text-green-700 dark:bg-green-950 dark:text-green-300"
                          : "bg-zinc-100 text-zinc-500 dark:bg-zinc-900 dark:text-zinc-400"
                      }`}
                    >
                      <span aria-hidden="true">{service.is_active ? "✓" : "✕"}</span>
                      {service.is_active ? "Активна" : "Неактивна"}
                    </span>
                  </div>
                  {service.description ? (
                    <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
                      {service.description}
                    </p>
                  ) : null}
                  <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
                    {formatDurationForDisplay(service.duration_minutes)} ·{" "}
                    {formatPriceForDisplay(service.price_cents)} · порядок {service.sort_order}
                  </p>
                </div>
                <ServiceActiveToggle serviceId={service.id} isActive={service.is_active} />
              </div>

              <details className="mt-3">
                <summary className="cursor-pointer text-sm font-medium text-zinc-700 dark:text-zinc-300">
                  Изменить
                </summary>
                <div className="mt-3">
                  <ServiceForm
                    service={{
                      id: service.id,
                      name: service.name,
                      description: service.description,
                      durationMinutes: service.duration_minutes,
                      priceCents: service.price_cents,
                      sortOrder: service.sort_order,
                      isActive: service.is_active,
                    }}
                  />
                </div>
              </details>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
