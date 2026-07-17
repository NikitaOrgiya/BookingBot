import { createAuthServerClient } from "@/lib/supabase/auth-server-client";
import { getAdminBusinessSettings } from "@/lib/admin/business-settings";
import { toBusinessLocalParts, formatDateForDisplay } from "@/lib/telegram/formatters";
import {
  WorkingHourForm,
  WEEKDAY_LABELS,
} from "@/components/admin/working-hours-form";
import { ScheduleBlockForm } from "@/components/admin/schedule-block-form";
import { ActionButton } from "@/components/admin/action-button";
import {
  createScheduleBlock,
  deleteScheduleBlock,
  deleteWorkingHour,
  setWorkingHourActive,
  updateScheduleBlock,
} from "./actions";

interface WorkingHourRow {
  id: string;
  weekday: number;
  start_time: string;
  end_time: string;
  is_active: boolean;
}

interface ScheduleBlockRow {
  id: string;
  starts_at: string;
  ends_at: string;
  reason: string | null;
}

async function loadScheduleData() {
  const settings = await getAdminBusinessSettings();
  const supabase = await createAuthServerClient();

  const [workingHoursResult, blocksResult] = await Promise.all([
    supabase
      .from("working_hours")
      .select("id, weekday, start_time, end_time, is_active")
      .order("weekday", { ascending: true })
      .order("start_time", { ascending: true }),
    supabase
      .from("schedule_blocks")
      .select("id, starts_at, ends_at, reason")
      .gt("ends_at", new Date().toISOString())
      .order("starts_at", { ascending: true })
      .limit(50),
  ]);

  if (workingHoursResult.error) {
    console.error("[admin] Не удалось получить расписание:", workingHoursResult.error);
    throw new Error("Не удалось получить расписание.");
  }
  if (blocksResult.error) {
    console.error("[admin] Не удалось получить блокировки:", blocksResult.error);
    throw new Error("Не удалось получить блокировки.");
  }

  return {
    settings,
    workingHours: (workingHoursResult.data ?? []) as WorkingHourRow[],
    blocks: (blocksResult.data ?? []) as ScheduleBlockRow[],
  };
}

export default async function AdminSchedulePage() {
  const { settings, workingHours, blocks } = await loadScheduleData();

  const byWeekday = Array.from({ length: 7 }, (_, weekday) =>
    workingHours.filter((wh) => wh.weekday === weekday)
  );

  return (
    <div className="flex flex-col gap-10">
      <header>
        <h1 className="text-2xl font-semibold text-zinc-950 dark:text-zinc-50">Расписание</h1>
        <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
          Часовой пояс организации: {settings.timezone}. Изменения здесь сразу влияют на
          свободные слоты в Telegram-боте.
        </p>
      </header>

      <section className="flex flex-col gap-4">
        <h2 className="text-lg font-semibold text-zinc-950 dark:text-zinc-50">
          Недельное расписание
        </h2>
        <div className="flex flex-col gap-4">
          {byWeekday.map((intervals, weekday) => (
            <div
              key={weekday}
              className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950"
            >
              <h3 className="mb-3 font-medium text-zinc-950 dark:text-zinc-50">
                {WEEKDAY_LABELS[weekday]}
              </h3>
              {intervals.length === 0 ? (
                <p className="mb-3 text-sm text-zinc-500 dark:text-zinc-400">
                  Нет рабочих интервалов.
                </p>
              ) : (
                <ul className="mb-3 flex flex-col gap-2">
                  {intervals.map((interval) => (
                    <li
                      key={interval.id}
                      className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-zinc-100 px-3 py-2 text-sm dark:border-zinc-900"
                    >
                      <span className="text-zinc-950 dark:text-zinc-50">
                        {interval.start_time.slice(0, 5)}–{interval.end_time.slice(0, 5)}{" "}
                        <span
                          className={
                            interval.is_active
                              ? "text-green-700 dark:text-green-400"
                              : "text-zinc-400 dark:text-zinc-500"
                          }
                        >
                          ({interval.is_active ? "активен" : "неактивен"})
                        </span>
                      </span>
                      <div className="flex gap-2">
                        {/* .bind() на серверном экшене, а не стрелочная функция — обычную
                            замыкающую функцию Server Component не может передать Client
                            Component как проп (React отклоняет это в рантайме), а bind()
                            возвращает связанную ссылку на сам Server Action. */}
                        <ActionButton
                          label={interval.is_active ? "Деактивировать" : "Активировать"}
                          action={setWorkingHourActive.bind(null, interval.id, !interval.is_active)}
                        />
                        <ActionButton
                          label="Удалить"
                          variant="danger"
                          confirmMessage="Удалить этот рабочий интервал?"
                          action={deleteWorkingHour.bind(null, interval.id)}
                        />
                      </div>
                    </li>
                  ))}
                </ul>
              )}
              <WorkingHourForm defaultWeekday={weekday} />
            </div>
          ))}
        </div>
      </section>

      <section className="flex flex-col gap-4">
        <h2 className="text-lg font-semibold text-zinc-950 dark:text-zinc-50">
          Блокировки и выходные
        </h2>

        <div className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950">
          <h3 className="mb-3 font-medium text-zinc-950 dark:text-zinc-50">Новая блокировка</h3>
          <ScheduleBlockForm action={createScheduleBlock} timeZone={settings.timezone} />
        </div>

        {blocks.length === 0 ? (
          <p className="rounded-lg border border-dashed border-zinc-300 p-6 text-center text-sm text-zinc-500 dark:border-zinc-700 dark:text-zinc-400">
            Предстоящих блокировок нет.
          </p>
        ) : (
          <ul className="flex flex-col gap-3">
            {blocks.map((block) => {
              const start = toBusinessLocalParts(block.starts_at, settings.timezone);
              const end = toBusinessLocalParts(block.ends_at, settings.timezone);
              return (
                <li
                  key={block.id}
                  className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <p className="font-medium text-zinc-950 dark:text-zinc-50">
                        {formatDateForDisplay(start.date)}, {start.time.slice(0, 5)}–
                        {end.date === start.date ? "" : `${formatDateForDisplay(end.date)}, `}
                        {end.time.slice(0, 5)}
                      </p>
                      {block.reason ? (
                        <p className="text-sm text-zinc-500 dark:text-zinc-400">{block.reason}</p>
                      ) : null}
                    </div>
                    <ActionButton
                      label="Удалить"
                      variant="danger"
                      confirmMessage="Удалить эту блокировку?"
                      action={deleteScheduleBlock.bind(null, block.id)}
                    />
                  </div>

                  <details className="mt-3">
                    <summary className="cursor-pointer text-sm font-medium text-zinc-700 dark:text-zinc-300">
                      Изменить
                    </summary>
                    <div className="mt-3">
                      <ScheduleBlockForm
                        action={updateScheduleBlock}
                        timeZone={settings.timezone}
                        submitLabel="Сохранить изменения"
                        block={{
                          id: block.id,
                          localDate: start.date,
                          startTime: start.time.slice(0, 5),
                          endTime: end.time.slice(0, 5),
                          reason: block.reason,
                        }}
                      />
                    </div>
                  </details>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
