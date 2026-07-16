# BookingBot

Telegram-бот для онлайн-записи клиентов с административной веб-панелью.
Портфолио-проект, спроектированный так, чтобы им можно было пользоваться в
реальном малом бизнесе: клиент бронирует время в Telegram, администратор
управляет услугами, расписанием и записями через защищённую веб-панель.

## Статус проекта

Проект разрабатывается поэтапно.

**Этап 0: инициализация** — готово.

- базовый Next.js-проект (App Router, TypeScript strict, Tailwind CSS);
- ESLint;
- Zod-валидация переменных окружения (`lib/env.ts`);
- каркас структуры каталогов проекта;
- минимальная адаптивная главная страница;
- Vitest с базовым тестом.

**Этап 1: база данных и безопасность** — готово.

- SQL-миграции всех основных таблиц (`supabase/migrations/`);
- ограничения и индексы, включая exclusion constraint против двойного
  бронирования;
- Row Level Security на всех рабочих таблицах;
- функция `public.is_admin()` (SECURITY DEFINER);
- явные `REVOKE`/`GRANT` для ролей `anon`, `authenticated`, `service_role`;
- RLS-политики для административной панели;
- `supabase/seed.sql` со стартовыми настройками организации;
- pgTAP-тесты на GRANT, RLS и SECURITY DEFINER (`supabase/tests/`).

**Намеренно не реализовано пока:** Telegram-бот, административная панель,
авторизация, напоминания, функции доступности и бронирования
(`get_available_slots`, `reserve_appointment`, `cancel_appointment_by_client`
— это Этап 2). Эти части будут добавлены на следующих этапах согласно
техническому заданию.

## Технологический стек

- Next.js (App Router) + React + TypeScript (strict)
- Tailwind CSS
- Supabase: PostgreSQL, Auth, Row Level Security
- Telegram Bot API (grammY) — будет подключено на этапе 3
- Zod — валидация всех внешних данных
- Vitest — unit-тесты
- Playwright — E2E-тесты (появятся позже)
- GitHub Actions + Vercel

## Структура каталогов

```text
app/                    Next.js App Router: страницы и API-роуты
  login/                страница входа администратора (заглушка)
  admin/                административная панель (заглушка)
  api/telegram/webhook/  Telegram webhook (заглушка)
  api/cron/reminders/    endpoint напоминаний (заглушка)

components/
  admin/                компоненты админ-панели
  ui/                   переиспользуемые UI-компоненты

lib/
  booking/              логика доступности и бронирования
  telegram/              бот, клавиатуры, обработчики
  supabase/              клиенты Supabase
  auth/                  проверка прав администратора
  env.ts                 Zod-валидация переменных окружения

scripts/                скрипты настройки Telegram webhook, проверки env

supabase/
  migrations/            SQL-миграции
  seed.sql               стартовые данные (business_settings)
  tests/                 SQL-тесты безопасности (pgTAP)

tests/
  unit/                  Vitest
  integration/           интеграционные тесты
  e2e/                   Playwright
```

Папки, ещё не наполненные кодом на этом этапе, сохранены в Git через
файлы `.gitkeep`, чтобы зафиксировать целевую структуру проекта.

## Работа с переменными окружения

Все переменные описаны в `.env.example`. Реальные значения хранятся в
локальном `.env.local` и никогда не коммитятся.

Секретные серверные переменные (`SUPABASE_SERVICE_ROLE_KEY`,
`TELEGRAM_BOT_TOKEN` и другие) проверяются через Zod в `lib/env.ts`. Этот
модуль импортирует пакет `server-only`, поэтому попытка использовать его в
клиентском компоненте приведёт к ошибке сборки — секреты физически не могут
попасть в браузер через этот модуль.

## База данных

Схема описана в `supabase/migrations/` — по одной миграции на таблицу (плюс
расширения/helpers, `is_admin()` и итоговое ужесточение прав), в порядке,
в котором их нужно применять. Основные таблицы: `business_settings`,
`admin_users`, `services`, `working_hours`, `schedule_blocks`,
`telegram_users`, `booking_sessions`, `appointments`,
`processed_telegram_updates`, `notification_deliveries`.

### Защита от двойного бронирования

Проверка свободного слота перед показом кнопки клиенту недостаточна: между
показом и нажатием кнопки другое подтверждение может успеть занять то же
время. Поэтому окончательное решение всегда принимает PostgreSQL в момент
вставки строки — на таблице `appointments` определён exclusion constraint:

```sql
exclude using gist (
  tstzrange(start_at, end_at, '[)') with &&
) where (status in ('confirmed', 'completed', 'no_show'))
```

Два активных (не отменённых) интервала времени физически не могут
пересечься — вставка второго упадёт с `SQLSTATE 23P01` (`exclusion_violation`),
которую сервер конвертирует в понятный клиенту код `SLOT_TAKEN` (появится на
Этапе 2 вместе с функцией `reserve_appointment`). Это проверено тестом
`supabase/tests/permissions.test.sql`: параллельная вставка второй
пересекающейся записи отклоняется базой данных, а не кодом приложения.

### RLS и GRANT — два независимых механизма

Ключевой принцип, вокруг которого построена вся схема: **RLS-политика и
табличная привилегия (`GRANT`) — это два разных механизма, и для доступа к
строке нужны оба одновременно.**

- `GRANT` отвечает на вопрос "может ли роль вообще выполнить `SELECT`/
  `INSERT`/... над этой таблицей?". Без него запрос падает с
  `permission denied` ещё до применения RLS.
- RLS-политика отвечает на вопрос "какие именно строки роль увидит/изменит,
  если привилегия уже есть?". Без подходящей политики роль с валидным
  `GRANT` получит пустой результат, а не ошибку.

По умолчанию Supabase выдаёт ролям `anon`/`authenticated` широкие
привилегии на новые таблицы схемы `public` — поэтому первая миграция
(`20260716100000_extensions_and_helpers.sql`) явно отзывает все права:

```sql
revoke all on all functions in schema public from public;
revoke all on all tables in schema public from anon;
revoke all on all tables in schema public from authenticated;
```

После этого каждая последующая миграция выдаёт только то, что
действительно нужно этой конкретной таблице:

| Таблица | `anon` | `authenticated` | `service_role` |
|---|---|---|---|
| `admin_users` | — | — | — (только через `is_admin()`) |
| `business_settings` | — | SELECT, UPDATE | SELECT |
| `services` / `working_hours` / `schedule_blocks` | — | SELECT, INSERT, UPDATE, DELETE | SELECT |
| `telegram_users` | — | SELECT | SELECT, INSERT, UPDATE |
| `booking_sessions` | — | — | SELECT, INSERT, UPDATE, DELETE |
| `appointments` | — | SELECT, UPDATE | SELECT, INSERT, UPDATE |
| `processed_telegram_updates` | — | — | SELECT, INSERT |
| `notification_deliveries` | — | SELECT | SELECT, INSERT, UPDATE |

`anon` не имеет доступа ни к одной рабочей таблице: Telegram-бот и cron
работают через `service_role` на сервере, а не через анонимный ключ.
`authenticated` (администратор в панели) не может ни создать запись, ни
удалить её напрямую — только через `SELECT`/`UPDATE`, с обязательной
проверкой `public.is_admin()` в каждой RLS-политике. `service_role`
использует `BYPASSRLS`, но это не освобождает его от `GRANT` — привилегии
выданы явно для каждой таблицы, которая ему реально нужна.

`public.is_admin()` — `SECURITY DEFINER` функция с зафиксированным
`search_path` и полными именами таблиц (чтобы вызывающая роль не могла
подменить `public.admin_users` через свой `search_path`). Выполнять её
может только `authenticated`; таблица `admin_users` при этом недоступна
напрямую вообще никому — только через эту функцию.

### Локальная проверка миграций

Мы работаем не в самом Supabase, а в обычном PostgreSQL, поэтому для
локальных тестов нужно сначала создать роли `anon`/`authenticated`/
`service_role` и заглушку схемы `auth` (в реальном Supabase-проекте они уже
есть, создавать их в `supabase/migrations/` нельзя — это ломает
production-проект):

```bash
createdb bookingbot_test
psql bookingbot_test -f supabase/tests/local_bootstrap.sql   # только для локальных тестов
for f in supabase/migrations/*.sql; do psql bookingbot_test -f "$f"; done
psql bookingbot_test -f supabase/seed.sql
```

Против настоящего Supabase-проекта `local_bootstrap.sql` не запускается —
там применяются только файлы из `supabase/migrations/` и `seed.sql`
(например, через `supabase db push` или `supabase migration up`).

### SQL-тесты (pgTAP)

`supabase/tests/permissions.test.sql` проверяет GRANT, RLS и
`SECURITY DEFINER` отдельно друг от друга: точный набор привилегий каждой
роли на каждой таблице, что RLS включена и принудительна (`FORCE`) везде,
кроме `admin_users`, что `anon` не видит вообще ничего, что обычный
`authenticated`-пользователь не видит админских данных (0 строк, не
ошибка), что администратор видит и может менять услуги/расписание, но не
может обойти ограничения (ни `CHECK`, ни отсутствующий `GRANT` на `INSERT`
в `appointments`), и что двойное бронирование, повторный Telegram update и
повторное напоминание отклоняются самой базой данных.

```bash
apt-get install -y postgresql-16-pgtap   # один раз, локально или в CI
createdb bookingbot_test
psql bookingbot_test -f supabase/tests/local_bootstrap.sql
for f in supabase/migrations/*.sql; do psql bookingbot_test -f "$f"; done
psql bookingbot_test -f supabase/seed.sql
psql bookingbot_test -c 'create extension if not exists pgtap;'
pg_prove -d bookingbot_test supabase/tests/permissions.test.sql
```

## Локальный запуск

Требуется Node.js версии из `.nvmrc` (используйте `nvm use`).

```bash
npm install
cp .env.example .env.local
# заполните .env.local реальными значениями
npm run dev
```

Приложение будет доступно на http://localhost:3000.

## Команды проверки

```bash
npm run lint        # ESLint
npm run typecheck   # проверка типов TypeScript
npm run test         # unit-тесты (Vitest)
npm run build        # production build
```

## Дальнейшие этапы

1. ~~База данных и безопасность (миграции, RLS, GRANT).~~ Готово.
2. Механизм доступности и атомарное бронирование
   (`get_available_slots`, `reserve_appointment`, `cancel_appointment_by_client`).
3. Telegram-бот.
4. Авторизация и административная панель.
5. Напоминания.
6. Полное тестирование (unit, SQL, integration, Playwright).
7. CI/CD и деплой на Vercel.
8. Финальное портфолио-оформление.

Подробности каждого этапа — в техническом задании проекта.
