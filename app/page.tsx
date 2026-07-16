const FEATURES = [
  "Выбор услуги и даты прямо в Telegram",
  "Показ только реально свободных слотов",
  "Защита от двойного бронирования на уровне PostgreSQL",
  "Напоминания клиентам перед визитом",
  "Отмена записи клиентом в разрешённый срок",
  "Административная панель для услуг, расписания и записей",
];

const STACK = [
  "Next.js",
  "React",
  "TypeScript",
  "Tailwind CSS",
  "Supabase (PostgreSQL, Auth, RLS)",
  "Telegram Bot API (grammY)",
  "Zod",
  "Vitest",
  "Playwright",
];

export default function Home() {
  return (
    <div className="flex flex-1 flex-col bg-zinc-50 font-sans dark:bg-black">
      <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-12 px-6 py-16 sm:px-10 sm:py-24">
        <header className="flex flex-col gap-4 text-center sm:text-left">
          <h1 className="text-3xl font-semibold tracking-tight text-zinc-950 sm:text-4xl dark:text-zinc-50">
            BookingBot
          </h1>
          <p className="text-lg leading-8 text-zinc-600 dark:text-zinc-400">
            Telegram-бот для онлайн-записи клиентов с административной
            веб-панелью. Клиент бронирует время в пару касаний, бизнес
            управляет услугами и расписанием через защищённую панель.
          </p>
          <div className="flex flex-col items-center gap-3 sm:flex-row sm:items-start">
            <span
              className="flex h-11 w-full items-center justify-center rounded-full bg-zinc-300 px-5 text-sm font-medium text-zinc-600 sm:w-auto dark:bg-zinc-800 dark:text-zinc-400"
              title="Бот ещё не опубликован"
            >
              Открыть Telegram-бот (скоро)
            </span>
            <span
              className="flex h-11 w-full items-center justify-center rounded-full border border-zinc-300 px-5 text-sm font-medium text-zinc-500 sm:w-auto dark:border-zinc-700 dark:text-zinc-500"
              title="Административная панель ещё в разработке"
            >
              Вход в панель администратора (скоро)
            </span>
          </div>
        </header>

        <section className="flex flex-col gap-4">
          <h2 className="text-xl font-semibold text-zinc-950 dark:text-zinc-50">
            Возможности
          </h2>
          <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {FEATURES.map((feature) => (
              <li
                key={feature}
                className="rounded-lg border border-zinc-200 bg-white p-4 text-sm text-zinc-700 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-300"
              >
                {feature}
              </li>
            ))}
          </ul>
        </section>

        <section className="flex flex-col gap-4">
          <h2 className="text-xl font-semibold text-zinc-950 dark:text-zinc-50">
            Технологический стек
          </h2>
          <ul className="flex flex-wrap gap-2">
            {STACK.map((tech) => (
              <li
                key={tech}
                className="rounded-full bg-zinc-200 px-3 py-1 text-xs font-medium text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300"
              >
                {tech}
              </li>
            ))}
          </ul>
        </section>

        <footer className="mt-auto flex flex-col gap-2 border-t border-zinc-200 pt-6 text-sm text-zinc-500 sm:flex-row sm:items-center sm:justify-between dark:border-zinc-800 dark:text-zinc-500">
          <p>Проект находится в активной разработке.</p>
          <a
            href="https://github.com/nikitaorgiya/bookingbot"
            target="_blank"
            rel="noopener noreferrer"
            className="font-medium text-zinc-700 underline underline-offset-4 hover:text-zinc-950 dark:text-zinc-300 dark:hover:text-zinc-50"
          >
            Исходный код на GitHub
          </a>
        </footer>
      </main>
    </div>
  );
}
