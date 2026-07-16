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

**Корректирующий этап (по итогам аудита Этапов 0-1)** — готово.

- закреплённая версия Node.js обновлена до актуальной LTS-ветки 24
  (`.nvmrc` + `engines.node` в `package.json`);
- `BUSINESS_TIMEZONE` теперь проверяется как настоящий IANA-идентификатор
  (`Europe/Moskow`, `UTC+3`, `Moscow` отклоняются, а не только "непустая
  строка");
- новая миграция `20260716120000_reminder_minutes_and_privilege_audit.sql`:
  `reminder_first_minutes`/`reminder_second_minutes` не могут быть
  отрицательными, плюс самопроверяющий блок, который сам падает с ошибкой,
  если после всех `REVOKE`/`GRANT` у `anon` осталась хоть одна табличная
  привилегия или SECURITY DEFINER-функция выполнима ролью `PUBLIC`;
- честно переописан последовательный pgTAP-тест exclusion constraint —
  он больше не выдаётся за проверку конкурентной гонки;
- добавлен настоящий integration-тест `tests/integration/double-booking-race.test.ts`
  с двумя независимыми подключениями к PostgreSQL;
- отдельные npm-команды `test:unit`/`test:sql`/`test:integration`/`test:all`.

**Этап 2: ядро бронирования** — готово.

- современная схема ключей Supabase (`sb_publishable_...` / `sb_secret_...`)
  вместо устаревших anon/service_role (`lib/env.ts`, `.env.example`);
- два раздельных Supabase-клиента: публичный низкопривилегированный
  (`lib/supabase/public-client.ts`) и серверный привилегированный
  server-only (`lib/supabase/server-client.ts`);
- три PostgreSQL-функции — `get_available_slots`, `reserve_appointment`,
  `cancel_appointment_by_client` (новые миграции, поверх уже применённой
  схемы) с фиксированным `search_path`, `REVOKE ALL` и `GRANT EXECUTE`
  только `service_role`, плюс самопроверяющий privilege-audit;
- шаг сетки слотов вынесен в настройку `business_settings.slot_step_minutes`
  (по умолчанию 15 минут) — задокументированная настройка, а не магическое
  число;
- серверный TypeScript-слой `lib/booking` со строгими типами,
  Zod-валидацией и стабильными доменными кодами ошибок (сырые сообщения
  PostgreSQL клиенту не показываются; `23P01` → `SLOT_TAKEN`);
- тесты: unit (env, server-only-граница, маппинг ошибок, Zod),
  pgTAP-сценарии слотов/резервации/отмены и интеграционный тест
  reserve/cancel через реальный PostgreSQL.

Подробности — в разделе "Этап 2: ядро бронирования" ниже.

**Этап 3: Telegram-бот и клиентский сценарий записи** — готово.

- grammY-бот (`lib/telegram/`) с раздельными модулями (кодек `callback_data`,
  клавиатуры, экраны, форматирование, репозитории, обработчики команд/колбэков)
  — без единого монолитного файла;
- полный клиентский сценарий: `/start` → главное меню → выбор услуги → дата →
  время → подтверждение → бронь → подтверждение брони; плюс просмотр своих
  записей, отмена своей записи, `/cancel` текущего сценария, безопасное
  восстановление после устаревшей кнопки;
- состояние диалога — только в таблице `booking_sessions` (никакой
  in-memory сессии — serverless), явная конечная модель состояний;
- идемпотентность Telegram-обновлений через `processed_telegram_updates` по
  модели atomic claim/release (новая миграция
  `20260716140000_processed_telegram_updates_claim_retry.sql`);
- вебхук (`app/api/telegram/webhook/route.ts`) проверяет
  `X-Telegram-Bot-Api-Secret-Token` константным по времени сравнением
  (встроено в grammY) и никогда не логирует полный Telegram update;
- `TELEGRAM_WEBHOOK_SECRET` теперь валидируется по ограничениям самого
  Telegram Bot API (1–256 символов, `A-Za-z0-9_-`); `BUSINESS_TIMEZONE`
  убран из `lib/env.ts` — часовой пояс всегда читается из
  `business_settings.timezone`, а не дублируется переменной окружения;
- unit- и интеграционные тесты (кодек колбэков, форматирование в часовом
  поясе бизнеса, переходы `booking_sessions`, безопасность вебхука,
  идемпотентность параллельных обновлений, изоляция записей по владельцу).

Подробности — в разделе "Этап 3: Telegram-бот" ниже.

**Намеренно не реализовано пока:** административная панель, авторизация,
напоминания. Эти части будут добавлены на следующих этапах согласно
техническому заданию.

## Технологический стек

- Next.js (App Router) + React + TypeScript (strict)
- Tailwind CSS
- Supabase: PostgreSQL, Auth, Row Level Security
- Telegram Bot API (grammY)
- Zod — валидация всех внешних данных
- Vitest — unit-тесты
- Playwright — E2E-тесты (появятся позже)
- GitHub Actions + Vercel

## Структура каталогов

```text
app/                    Next.js App Router: страницы и API-роуты
  login/                страница входа администратора (заглушка)
  admin/                административная панель (заглушка)
  api/telegram/webhook/  Telegram webhook (Route Handler, POST-only)
  api/cron/reminders/    endpoint напоминаний (заглушка)

components/
  admin/                компоненты админ-панели
  ui/                   переиспользуемые UI-компоненты

lib/
  booking/              логика доступности и бронирования
  telegram/              бот: bot.ts, context.ts, webhook-handler.ts,
                          callback-data.ts, keyboards.ts, messages.ts,
                          formatters.ts, screens.ts, respond.ts,
                          user-profile.ts, idempotency.ts,
                          handlers/ (commands.ts, callbacks.ts),
                          repositories/ (telegram-users, booking-sessions,
                          services, appointments, business-settings)
  supabase/              клиенты Supabase
  auth/                  проверка прав администратора
  env.ts                 Zod-валидация переменных окружения

scripts/
  test-sql.sh            прогон SQL/pgTAP-тестов на локальной базе
  telegram/               ручное управление Telegram-ботом (webhook, команды)

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

Секретные серверные переменные (`SUPABASE_SECRET_KEY`,
`TELEGRAM_BOT_TOKEN` и другие) проверяются через Zod в `lib/env.ts`. Этот
модуль импортирует пакет `server-only`, поэтому попытка использовать его в
клиентском компоненте приведёт к ошибке сборки — секреты физически не могут
попасть в браузер через этот модуль.

### Современная схема ключей Supabase

Проект использует актуальную схему ключей Supabase, а не устаревшие
anon/service_role:

- `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` (формат `sb_publishable_...`) —
  низкопривилегированный публичный ключ. Подчиняется RLS, безопасно
  попадает в браузер, используется только публичным клиентом
  (`lib/supabase/public-client.ts`). Заменяет `NEXT_PUBLIC_SUPABASE_ANON_KEY`.
- `SUPABASE_SECRET_KEY` (формат `sb_secret_...`) — секретный ключ, обходит
  RLS. Используется **только на сервере** привилегированным клиентом
  (`lib/supabase/server-client.ts`), который импортирует `server-only` и не
  может попасть в клиентский бандл. Заменяет `SUPABASE_SERVICE_ROLE_KEY`.

Публичный и серверный клиенты — это **два разных модуля**, а не один общий
клиент с переключаемой авторизацией: так пользовательская сессия физически
не может подменить привилегированный `Authorization`-заголовок секретного
ключа. Серверный клиент не хранит сессию и не обновляет токены
(`persistSession: false`, `autoRefreshToken: false`).

Начиная с Этапа 3 переменной `BUSINESS_TIMEZONE` в проекте больше нет:
единственный источник часового пояса — `business_settings.timezone` в базе
данных (уже проверенный `CHECK`-ограничением Этапа 1 как настоящий
IANA-идентификатор). Дублировать это значение отдельной переменной
окружения было избыточно и создавало риск рассинхронизации между env и
БД — `lib/telegram/repositories/business-settings.ts` читает его напрямую
оттуда при каждом обращении.

`TELEGRAM_WEBHOOK_SECRET` проверяется по собственным ограничениям Telegram
Bot API: 1–256 символов, только `A-Z`, `a-z`, `0-9`, `_` и `-`
(см. `setWebhook`/`secret_token` в документации Telegram). Значение
сверяется с заголовком `X-Telegram-Bot-Api-Secret-Token` константным по
времени сравнением — подробности в разделе "Этап 3: Telegram-бот".

`TEST_DATABASE_URL` нужен только для `npm run test:integration` (реальный
конкурентный тест) — это не переменная приложения и в `.env.example` она
не входит. Подробности — в разделе "SQL-тесты и настоящий конкурентный
тест".

## База данных

Схема описана в `supabase/migrations/` — по одной миграции на таблицу (плюс
расширения/helpers, `is_admin()` и итоговое ужесточение прав), в порядке,
в котором их нужно применять. Основные таблицы: `business_settings`,
`admin_users`, `services`, `working_hours`, `schedule_blocks`,
`telegram_users`, `booking_sessions`, `appointments`,
`processed_telegram_updates`, `notification_deliveries`.

Миграции применяются последовательно и не переписываются задним числом —
исправления оформляются новыми файлами. Например,
`20260716120000_reminder_minutes_and_privilege_audit.sql` добавляет поверх
уже применённой схемы:

- `CHECK`, запрещающий отрицательные `reminder_first_minutes` и
  `reminder_second_minutes` в `business_settings` (раньше были защищены
  только `min_booking_notice_minutes`/`cancellation_notice_minutes`);
- повторный `REVOKE ALL ... FROM PUBLIC` на функциях схемы `public` —
  на случай, если будущая `CREATE OR REPLACE FUNCTION` незаметно вернёт
  привилегию по умолчанию;
- блок `DO $$ ... $$`, который **падает с ошибкой при применении
  миграции**, если `anon` имеет хоть одну табличную привилегию в схеме
  `public` (лично или через псевдороль `PUBLIC`), если `authenticated`
  имеет доступ к `admin_users`/`booking_sessions`/`processed_telegram_updates`
  или `INSERT`/`DELETE` на `appointments`, либо если какая-то
  `SECURITY DEFINER`-функция выполнима ролью `PUBLIC`. Это не просто
  комментарий с намерением: `psql` реально прерывает миграцию, если
  что-то из этого правда (проверено вручную — временный `grant select on
  services to anon` действительно валит блок с понятным сообщением).

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
Этапе 2 вместе с функцией `reserve_appointment`). Это защита на уровне двух
разных тестов с разными гарантиями (не путать один с другим):

- `supabase/tests/permissions.test.sql` — **последовательный** pgTAP-тест:
  доказывает, что constraint определён правильно (два INSERT одного за
  другим в одной сессии, второй отклоняется). Он **не** проверяет
  конкурентную гонку — оба запроса выполняются друг за другом, а не
  одновременно.
- `tests/integration/double-booking-race.test.ts` — **настоящий**
  конкурентный тест: два независимых TCP-подключения к PostgreSQL
  одновременно (`Promise.allSettled`, без `await` между запросами)
  пытаются вставить один и тот же интервал. Ровно один запрос завершается
  успехом, второй — ошибкой `23P01`. Подробности и переменные окружения —
  в разделе "SQL-тесты и настоящий конкурентный тест" ниже.

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
`service_role` и заглушку схемы `auth` через
`supabase/tests/local_bootstrap.sql` (в реальном Supabase-проекте они уже
есть — создавать их в `supabase/migrations/` нельзя, это ломает
production-проект; там применяются только файлы из `supabase/migrations/`
и `seed.sql`, например через `supabase db push`). Команда `npm run
test:sql` (см. ниже) выполняет весь этот порядок автоматически.

### SQL-тесты и настоящий конкурентный тест

`supabase/tests/permissions.test.sql` (pgTAP) проверяет GRANT, RLS и
`SECURITY DEFINER` отдельно друг от друга: точный набор привилегий каждой
роли на каждой таблице, что RLS включена и принудительна (`FORCE`) везде,
кроме `admin_users`, что `anon` не видит вообще ничего, что обычный
`authenticated`-пользователь не видит админских данных (0 строк, не
ошибка), что администратор видит и может менять услуги/расписание, но не
может обойти ограничения (ни `CHECK`, включая новые `reminder_*_minutes`,
ни отсутствующий `GRANT` на `INSERT` в `appointments`), что повторный
Telegram update и повторное напоминание отклоняются самой базой данных, и
что exclusion constraint определён правильно (**последовательная**
проверка — см. предупреждение прямо в файле теста, почему это не
заменяет проверку гонки).

`supabase/tests/booking_functions.test.sql` (pgTAP) покрывает функции
Этапа 2: расчёт слотов (обычный день, несколько интервалов, неактивная
услуга, минимальное уведомление, горизонт, `schedule_block`, существующая и
отменённая запись, услуга не помещается, timezone-конвертация,
**пересекающиеся `working_hours` не дают дублей слотов**), атомарную
резервацию со snapshot, преобразование пересечения в `23P01`, права
функций (`PUBLIC`/`anon`/`authenticated` не могут выполнять, `service_role`
может) и клиентскую отмену (своя/чужая/поздняя/повторная/**`completed`
и `no_show` нельзя отменить — `APPOINTMENT_NOT_CANCELLABLE`**). Тестовый
горизонт бронирования в файле — 90 дней, а не больше: `booking_horizon_days`
ограничен `CHECK` (1–180) из Этапа 1.

Команда `npm run test:sql` делает всё одним вызовом
(`scripts/test-sql.sh`): пересоздаёт локальную базу `bookingbot_test`,
накатывает `local_bootstrap.sql` + все миграции + `seed.sql`, ставит
расширение `pgtap` и запускает `pg_prove` по всем `supabase/tests/*.test.sql`.
Параметры подключения — из обычных переменных libpq (`PGHOST`, `PGPORT`,
`PGUSER`, `PGPASSWORD`); по умолчанию используется локальный сокет текущего
пользователя.

```bash
apt-get install -y postgresql-16-pgtap   # один раз, локально или в CI
npm run test:sql
```

Настоящий тест конкурентной гонки —
`tests/integration/double-booking-race.test.ts` (Vitest + `pg`). В отличие
от pgTAP-теста выше, он открывает **два независимых** `pg.Client`-подключения
и отправляет оба `INSERT` одного и того же интервала без ожидания друг
друга (`Promise.allSettled`) — PostgreSQL обрабатывает каждое подключение в
своём backend-процессе, поэтому гонка происходит по-настоящему на уровне
базы данных, а не эмулируется в одном процессе Node.js. Тест проверяет, что
ровно один запрос успешен, ровно один отклонён с `SQLSTATE 23P01`, что в
таблице реально осталась одна строка (не ноль, не две), и в конце удаляет
все созданные им данные.

Требуемая переменная окружения — `TEST_DATABASE_URL`: строка подключения к
PostgreSQL с уже применёнными миграциями и `local_bootstrap.sql` (проще
всего — та же `bookingbot_test`, которую только что подготовил
`npm run test:sql`). Роль в строке подключения должна иметь право
выполнить `set role service_role` (суперпользователь — самый простой
вариант для локальной разработки/CI). Если переменная не задана, тест
пропускается (`describe.skipIf`), а не падает и не подделывает результат.

Рядом лежит `tests/integration/booking-functions.test.ts` — он использует ту
же `TEST_DATABASE_URL` и проверяет `reserve_appointment` /
`cancel_appointment_by_client` через реальный PostgreSQL под ролью
`service_role` (snapshot услуги, `23P01` при повторном бронировании,
отмена своей/чужой/поздней/повторной записи, `completed`/`no_show` нельзя
отменить, и что `telegramUserId` больше `Number.MAX_SAFE_INTEGER` не теряет
точность через реальный путь `pg → bigint`).

Отдельный файл — `tests/integration/reserve-appointment-race.test.ts`:
настоящая конкурентная гонка **на самой функции** `reserve_appointment` (в
отличие от `double-booking-race.test.ts`, который гоняет сырой `INSERT`
напрямую в `appointments`). Два независимых подключения одновременно
вызывают `reserve_appointment` на один и тот же слот одной услуги — ровно
один вызов успешен, второй падает с `23P01`. Второй тест в этом же файле
честно проверяет только то, что доказуемо в этой песочнице: что `23P01`
сопоставляется с `SLOT_TAKEN` на TypeScript-уровне (см. следующий раздел
про Telegram ID — та же оговорка про недоступный сквозной HTTP-путь через
`supabase-js` применима и здесь).

Без `TEST_DATABASE_URL` все интеграционные тесты пропускаются
(`describe.skipIf`), а не падают и не подделывают результат.

```bash
npm run test:sql   # готовит и мигрирует bookingbot_test
export TEST_DATABASE_URL="postgresql://postgres:<пароль>@127.0.0.1:5432/bookingbot_test"
npm run test:integration
```

## Этап 2: ядро бронирования

Вся логика доступности и бронирования вынесена в PostgreSQL-функции, а
серверный TypeScript-слой `lib/booking` — это тонкие обёртки: Zod-валидация
входа, вызов функции через привилегированный серверный клиент, маппинг
результата в стабильный тип и преобразование ошибок базы в доменные коды.

### Сигнатуры SQL-функций

```sql
public.get_available_slots(
  p_service_id uuid,
  p_from_date date default null,   -- нижняя граница окна (локальная дата), по умолчанию сегодня
  p_to_date   date default null    -- верхняя граница окна (локальная дата), по умолчанию конец горизонта
) returns table (slot_start timestamptz, slot_end timestamptz)

public.reserve_appointment(
  p_telegram_user_id bigint,       -- внешний Telegram-идентификатор клиента
  p_service_id uuid,
  p_start_at timestamptz,          -- начало приёма (выровнено до минуты)
  p_client_note text default null
) returns public.appointments

public.cancel_appointment_by_client(
  p_appointment_id uuid,
  p_telegram_user_id bigint,
  p_reason text default null
) returns public.appointments
```

Соответствующие обёртки — `getAvailableSlots`, `reserveAppointment`,
`cancelAppointmentByClient` из `lib/booking`.

### Telegram ID — строка, а не JavaScript number

`p_telegram_user_id` в БД — `bigint` (полная 64-битная точность). Telegram
ID теоретически может превысить `Number.MAX_SAFE_INTEGER` (2^53−1), после
чего JS `number` молча (без исключения) теряет точность. Поэтому на
TypeScript-уровне (`lib/booking/schemas.ts`) `telegramUserId` — это
**строка**, проверенная Zod-регулярным выражением
(`/^[1-9][0-9]*$/` — положительное десятичное целое без знака, ведущих
нулей и дробной части), и она проходит весь путь до RPC-вызова включительно
без единого `Number()`/`parseInt()`. `pg` передаёт строковый параметр как
текст, PostgreSQL приводит его к `bigint` через входную функцию типа —
это то же самое поведение, которым пользуется PostgREST при вызове RPC.

Это подтверждено интеграционным тестом
(`tests/integration/booking-functions.test.ts`, тест "не теряет точность"):
значение `9007199254740993` (`Number.MAX_SAFE_INTEGER + 2`) проходит через
реальный `pg`-путь к колонке `bigint` и обратно без изменений — тогда как
`Number("9007199254740993")` уже даёт другое число. Честная оговорка:
проверен путь `pg → PostgreSQL bigint`, которым идут все интеграционные
тесты этого репозитория; сквозной HTTP-путь через
`@supabase/supabase-js` `.rpc()` → PostgREST здесь не воспроизводим — в
песочнице разработки нет живого Supabase-проекта. Поведение PostgREST
документировано как приведение параметра к типу через ту же входную
функцию SQL-типа, поэтому ожидается идентичное поведение, но буквально
через HTTP это не проверялось.

### Алгоритм расчёта свободных слотов

`get_available_slots` работает так:

1. Читает `timezone`, `booking_horizon_days`, `min_booking_notice_minutes`
   и `slot_step_minutes` из `business_settings`, длительность и активность
   услуги из `services` (неактивная/несуществующая услуга → доменная
   ошибка, а не пустой результат).
2. Определяет окно локальных дат бизнеса: от `p_from_date` (или сегодня) до
   `p_to_date` (или `сегодня + booking_horizon_days`), клампя обе границы к
   `[сегодня, конец горизонта]`.
3. Для каждой локальной даты берёт активные интервалы `working_hours` этого
   дня недели (0 = понедельник; несколько интервалов в день поддерживаются).
4. В каждом интервале генерирует кандидатов с шагом `slot_step_minutes`,
   оставляя только те, где услуга **целиком** помещается в интервал по
   полуоткрытой семантике `[start, end)` (последний старт такой, что
   `start + duration <= end`).
5. Каждый локальный кандидат конвертируется в `timestamptz`
   **независимо** (`AT TIME ZONE`), что корректно и при переходах DST.
6. Отбрасывает слоты раньше, чем `now() + min_booking_notice_minutes`
   (это же условие убирает прошедшие слоты), пересекающиеся с
   `schedule_blocks` и с активными записями `appointments`
   (`confirmed`/`completed`/`no_show`). Отменённые записи время не
   блокируют.
7. Финальная выборка — `SELECT DISTINCT (slot_start, slot_end)`: ничто в
   схеме не запрещает администратору создать пересекающиеся интервалы
   `working_hours` одного дня (в ТЗ это лишь "желательно предупреждать" в
   будущей админ-панели, а не ограничение в БД); без `DISTINCT` слот из
   зоны пересечения появлялся бы в выдаче дважды — по разу на каждый
   интервал, который его порождает.

**Шаг сетки слотов.** В ТЗ и исходной схеме шаг нигде задан не был. Чтобы
не оставлять магическое число, он вынесен в настройку
`business_settings.slot_step_minutes` со значением по умолчанию **15 минут**
(`CHECK` 5–120). Администратор может изменить его, не трогая код функций.

`reserve_appointment` выполняет те же проверки атомарно (существование
клиента и активной услуги, минимальное уведомление, горизонт, попадание в
рабочее расписание, отсутствие блокировок), сохраняет **snapshot** имени,
длительности и цены услуги из серверного чтения (никогда не из входных
данных вызывающего), вычисляет `end_at` из длительности и вставляет запись.
Окончательная защита от конкурентного двойного бронирования — exclusion
constraint на `appointments`: пересекающаяся вставка падает с `23P01`,
которую TypeScript-слой преобразует в `SLOT_TAKEN`.

`cancel_appointment_by_client` не удаляет строку, а переводит статус в
`cancelled`, заполняет `cancelled_at` и причину; проверяет принадлежность
записи клиенту и `cancellation_notice_minutes`. Отменить можно только
запись со статусом `confirmed`: повторная отмена уже отменённой записи
отклоняется кодом `ALREADY_CANCELLED`, а любой другой статус (`completed`,
`no_show`) — кодом `APPOINTMENT_NOT_CANCELLABLE`, независимо от того,
наступил ли уже `start_at` записи.

### Доменные коды ошибок

Функции сигнализируют ошибки кастомным SQLSTATE класса `PB` (за пределами
зарезервированного стандартом диапазона `A`–`H`); серверный слой
(`lib/booking/errors.ts`) сопоставляет SQLSTATE со стабильным доменным
кодом. Сырой текст PostgreSQL клиенту не показывается — исходная ошибка
сохраняется в `cause` и логируется на сервере.

| Доменный код | SQLSTATE | Ситуация |
|---|---|---|
| `SERVICE_NOT_FOUND` | `PB001` | услуги нет |
| `SERVICE_INACTIVE` | `PB002` | услуга неактивна |
| `TELEGRAM_USER_NOT_FOUND` | `PB003` | клиента нет в `telegram_users` |
| `INVALID_START_TIME` | `PB004` | начало не задано / не выровнено до минуты |
| `OUTSIDE_BOOKING_HORIZON` | `PB005` | дата за пределами горизонта |
| `MIN_NOTICE_NOT_MET` | `PB006` | слишком близко к началу (или в прошлом) |
| `OUTSIDE_WORKING_HOURS` | `PB007` | не помещается в рабочее расписание |
| `SCHEDULE_BLOCKED` | `PB008` | пересекается со `schedule_blocks` |
| `SLOT_TAKEN` | `23P01` | слот занят (exclusion constraint) |
| `APPOINTMENT_NOT_FOUND` | `PB009` | записи нет |
| `APPOINTMENT_NOT_OWNED` | `PB010` | запись принадлежит другому клиенту |
| `CANCELLATION_TOO_LATE` | `PB011` | отмена позже допустимого срока |
| `ALREADY_CANCELLED` | `PB012` | запись уже отменена |
| `APPOINTMENT_NOT_CANCELLABLE` | `PB013` | статус записи не `confirmed` (`completed`/`no_show`) |
| `INTERNAL_ERROR` | (прочее) | неизвестная ошибка (залогирована на сервере) |

### Модель безопасности функций

Все три функции объявлены `SECURITY INVOKER` (без `SECURITY DEFINER`):
единственный вызывающий — серверный бот под ролью `service_role`, у которой
уже есть `BYPASSRLS` и необходимые табличные `GRANT`, поэтому повышать права
незачем. У каждой функции зафиксирован `search_path = public, pg_temp`, все
объекты адресуются по полному имени `public.*`, `EXECUTE` отозван у
`PUBLIC`/`anon`/`authenticated` и выдан только `service_role`. Миграция
`20260716130200_booking_functions_privilege_audit.sql` **падает при
применении**, если это не так (аналогично privilege-audit Этапа 1).

### Новые миграции (поверх уже применённой схемы, timestamp > 20260716120000)

- `20260716130000_business_settings_slot_step.sql` — столбец
  `slot_step_minutes` (по умолчанию 15, `CHECK` 5–120);
- `20260716130100_booking_functions.sql` — три функции + `REVOKE`/`GRANT`;
- `20260716130200_booking_functions_privilege_audit.sql` — самопроверка
  прав новых функций.

Существующие применённые миграции (timestamp ≤ `20260716120000`) не
переписываются. `20260716130100_booking_functions.sql` правился на месте
(добавлен `PB013`/`APPOINTMENT_NOT_CANCELLABLE`, `SELECT DISTINCT` в
`get_available_slots`) — это осознанно допустимо только потому, что эти
три файла ещё ни разу не применялись к облачному Supabase-проекту; после
первого реального применения такие файлы уже нельзя будет так же
редактировать задним числом, а только новой корректирующей миграцией
(как `20260716120000` после Этапа 1). Миграции применяются владельцем
проекта только после `supabase db diff`/dry-run (в этом репозитории
`supabase db push` не выполнялся — см. финальные замечания ниже).

## Этап 3: Telegram-бот

Бот построен на [grammY](https://grammy.dev/), в отдельных модулях
`lib/telegram/` — без единого монолитного файла:

```text
lib/telegram/
  bot.ts                  сборка Bot<BotContext>, порядок middleware
  context.ts              расширение Context: telegramUserId/telegramUserRowId
  webhook-handler.ts       Request → Response поверх webhookCallback("std/http")
  callback-data.ts         кодек callback_data инлайн-кнопок (кодирование/decode)
  keyboards.ts             InlineKeyboard для каждого экрана
  messages.ts              русскоязычные тексты + доменная ошибка → сообщение
  formatters.ts             дата/время/цена/длительность в часовом поясе бизнеса
  screens.ts               чистые (текст, клавиатура) — без обращений к БД
  respond.ts               replyWithScreen (команды) / editWithScreen (колбэки)
  user-profile.ts          Telegram User → безопасный профиль (id как строка)
  idempotency.ts           claim/release для processed_telegram_updates
  handlers/
    commands.ts             /start /book /mybookings /help /cancel
    callbacks.ts             диспетчер callback_query, все переходы сценария
  repositories/
    telegram-users.ts        upsert профиля клиента
    booking-sessions.ts      чтение/запись/очистка booking_sessions
    services.ts               список услуг + повторная проверка по id
    appointments.ts           свои записи (владение проверяется в WHERE)
    business-settings.ts     timezone/booking_horizon_days из БД
```

### Клиентский сценарий

`/start` показывает главное меню («Записаться», «Мои записи», «Помощь»).
Сценарий записи: выбор услуги (только активные, в порядке `sort_order`) →
выбор даты (в часовом поясе бизнеса, без прошедших дат, в пределах
`booking_horizon_days`, с пагинацией) → выбор времени (только через
`getAvailableSlots`) → экран подтверждения (услуга/дата/время/
длительность/цена/часовой пояс, кнопки «Подтвердить»/«Назад»/«Отменить») →
`reserveAppointment` → подтверждение или понятная ошибка. Кнопка «Назад»
работает на каждом шаге; `/cancel` в любой момент прерывает текущий
незавершённый сценарий (это **не** отмена уже созданной записи — для неё
отдельная кнопка «Отменить запись» в «Мои записи»). Устаревшая/подделанная
кнопка (другой сценарий, истёкшая сессия, чужой параметр) никогда не
обрабатывается вслепую — бот сбрасывает сессию и просит начать заново.

Все мутации проходят только через существующие обёртки Этапа 2 —
`getAvailableSlots`, `reserveAppointment`, `cancelAppointmentByClient`;
Telegram-код никогда не вставляет строки в `appointments` напрямую.
`service_id`, `appointmentId`, дата и время из `callback_data` всегда
перепроверяются на сервере (деактивированная услуга, чужая/несуществующая
запись, занятый слот) — кнопка лишь подсказывает намерение клиента, а не
является источником истины.

### booking_sessions — явная конечная модель состояний

Состояние диалога живёт только в таблице `booking_sessions`, не в памяти
процесса (serverless-среда не гарантирует переиспользование инстанса между
запросами):

```
idle → choosing_service → choosing_date → choosing_slot → confirming
                                                              │
                                                    reserveAppointment
                                                              │
                                                              ▼
                                                        (снова idle)
```

`step` в БД — свободный `text` без `CHECK` (Этап 1 не ограничивал набор
значений), поэтому весь набор допустимых состояний контролируется в
приложении (`BOOKING_SESSION_STEPS` в `booking-sessions.ts`). Каждый
переход: (1) читает текущее состояние и проверяет, что колбэк соответствует
ожидаемому шагу — иначе это устаревшая кнопка; (2) `telegram_user_id`
всегда берётся из аутентифицированного контекста запроса, а не из
`callback_data` — подменить чужую сессию нельзя; (3) полностью заменяет все
четыре поля состояния разом (не частичный `patch`), чтобы шаг «назад» не
мог оставить данные более позднего шага; (4) продлевает `expires_at` (TTL
30 минут). Просроченная или структурно повреждённая (нераспознанный
`step` — например, от будущей несовместимой версии бота) сессия безопасно
трактуется как `idle`, а не как ошибка.

### Идемпотентность Telegram-обновлений

Telegram может повторно доставить один и тот же `update_id` (не получив
вовремя `200 OK`). Защита — `processed_telegram_updates` по модели
**claim → process → release-on-failure**, реализованной в
`lib/telegram/idempotency.ts`:

1. **claim** — `INSERT telegram_update_id`. Атомарность обеспечивает
   первичный ключ таблицы, а не `SELECT`, а потом отдельный `INSERT`: два
   параллельных запроса с одним `update_id` всегда дают ровно один успешный
   `INSERT` и один конфликт `23505`, в любом порядке выполнения. Конфликт
   означает «уже обрабатывается параллельно или уже полностью обработан
   ранее» — обработка пропускается, webhook отвечает успехом без повторного
   бизнес-действия.
2. Если обработка (получение сессии, вызов `reserveAppointment`/
   `cancelAppointmentByClient` и т.д.) бросает исключение — **release**
   (`DELETE` claim), чтобы следующая доставка того же `update_id` получила
   новую попытку, а не молчаливо считалась обработанной, хотя бизнес-действие
   не завершилось.
3. Если обработка успешна — claim остаётся навсегда: этот конкретный
   `update_id` больше никогда не обрабатывается повторно.

Это требует `DELETE` для `service_role` на `processed_telegram_updates`,
которого не было в изначальной схеме Этапа 1 (там был только
`SELECT`+`INSERT` — этого достаточно для однократной регистрации, но не для
отката). Новая миграция
`20260716140000_processed_telegram_updates_claim_retry.sql` выдаёт этот
`DELETE` и **падает при применении**, если после `REVOKE`/`GRANT`
`anon`/`authenticated`/`PUBLIC` получили хоть какую-то привилегию на эту
таблицу, если `service_role` не имеет ровно `SELECT`+`INSERT`+`DELETE`, или
если у него оказался лишний `UPDATE` (эта модель его не требует). Права
`anon`/`authenticated` не меняются вообще — они как не имели доступа к этой
таблице, так и не имеют.

Middleware в `lib/telegram/bot.ts` выполняет claim первым, до всего
остального: если `next()` (весь дальнейший конвейер — определение чата,
профиль клиента, обработчик команды/колбэка) бросает исключение, claim
освобождается и ошибка пробрасывается дальше — наверх, к webhook route,
который вернёт Telegram статус, вызывающий повторную доставку.

### Безопасность вебхука

`app/api/telegram/webhook/route.ts` экспортирует только `POST` — Next.js
сам вернёт `405` на любой другой метод. Проверка заголовка
`X-Telegram-Bot-Api-Secret-Token` встроена в grammY (`webhookCallback` с
`secretToken`): сравнение — константное по времени побайтовое XOR без
короткого замыкания (`compareSecretToken` в
`node_modules/grammy/out/convenience/webhook.js`), и оно выполняется
**до** разбора тела запроса как JSON — неверный или отсутствующий секрет
получает `401`, не коснувшись полезной нагрузки. Отдельная ручная проверка
секрета не добавляла бы защиты поверх уже константной по времени проверки
grammY, поэтому `lib/telegram/webhook-handler.ts` полагается на неё, а не
дублирует.

`TELEGRAM_BOT_TOKEN` никогда не попадает в URL/лог/текст ошибки, которые
видит кто-либо, кроме сервера: ни один `console.*` в Telegram-коде его не
печатает, а ручные `scripts/telegram/*` скрипты используют `redactToken()`
на случай, если сетевая ошибка `fetch` включит URL целиком. При внутренней
ошибке обработки update `webhook-handler.ts` логирует **только**
`update_id`, тип update (`message`/`callback_query`/...) и стабильный
внутренний код ошибки — никогда весь объект update (там может быть текст
сообщения, имя клиента и т.д.) и никогда сырой текст ошибки БД; в ответ
Telegram уходит `5xx` без тела, чтобы он повторил доставку, а не `2xx`
с фактически невыполненным действием.

### callback_data — компактный кодек, не JSON

`lib/telegram/callback-data.ts`: формат `"1|<action>|<payload>"` (версия,
действие, необязательная нагрузка), разделитель `|`, а не `:` — потому что
payload может быть ISO-датой вида `2026-07-20T11:00:00+03:00`, которая сама
содержит `:`. UUID/дата/datetime/номер страницы проверяются строгими
Zod-схемами (`z.uuid()`, `z.iso.date()`, `z.iso.datetime({ offset: true })`);
неизвестное действие, неверная версия, повреждённый формат или невалидное
значение — `decodeCallbackData` возвращает `null`, а не бросает исключение,
и вызывающий код обязан явно обработать `null` (см. `showStaleButton` в
`handlers/callbacks.ts`). В payload нет ни PII, ни секретов, ни больших
JSON — только сам параметр (id/дата/время/страница). `handleCallbackQuery`
вызывает `ctx.answerCallbackQuery()` в `finally` — гарантированно, даже
если разбор данных не удался или обработчик бросил исключение, иначе
кнопка в интерфейсе Telegram виснет с крутящимся индикатором навсегда.

### Команды бота

| Команда | Действие |
|---|---|
| `/start` | приветствие + главное меню |
| `/book` | начать (или начать заново) сценарий записи |
| `/mybookings` | список своих будущих подтверждённых записей |
| `/help` | список команд |
| `/cancel` | отменить **текущий незавершённый сценарий записи** (не запись в БД) |

Бот работает только в личных чатах — `bot.chatType("private")` в
`lib/telegram/bot.ts` не пропускает обновления из групп/супергрупп/каналов
дальше профиля клиента и сценария бронирования.

### Ручная настройка бота (BotFather + вебхук)

Ничего из этого **не выполнялось** в рамках разработки — ни к какому
реальному Telegram-боту не обращались (`scripts/telegram/*` не запускались
с реальным токеном; `TELEGRAM_BOT_TOKEN` в этом окружении нет).

1. Создать бота через [@BotFather](https://t.me/BotFather), получить
   `TELEGRAM_BOT_TOKEN` и `TELEGRAM_BOT_USERNAME`, заполнить их в
   `.env.local` вместе со сгенерированным самостоятельно
   `TELEGRAM_WEBHOOK_SECRET` (1–256 символов, `A-Za-z0-9_-`).
2. Задеплоить приложение на HTTPS-адрес (Vercel — Этап 7) и убедиться, что
   `NEXT_PUBLIC_APP_URL` в продакшен-окружении указывает на этот адрес.
3. Только после этого — `npm run telegram:webhook:set` (регистрирует
   `https://<домен>/api/telegram/webhook` с `secret_token` и
   `allowed_updates: ["message", "callback_query"]`) и
   `npm run telegram:commands:set` (регистрирует список команд в меню
   Telegram). `npm run telegram:webhook:info` — проверить текущее
   состояние, `npm run telegram:webhook:delete` — снять вебхук
   (`--drop-pending-updates` — явный флаг для сброса очереди накопленных
   обновлений, по умолчанию они сохраняются).

Ни один из этих скриптов не выполняется автоматически (не часть
`dev`/`build`/`test`/CI) и не печатает значения токена/секрета.

### Тесты Этапа 3

Unit (`tests/unit/telegram-*.test.ts`, без БД и без сети):
`telegram-callback-data` (кодек, unknown action, невалидный UUID/дата/
datetime/страница, лимит в 64 байта), `telegram-user-profile` (немедленная
конвертация id в строку), `telegram-formatters` (дата/время/длительность/
цена в конкретном часовом поясе — не в серверном), `telegram-messages`
(каждый `BookingErrorCode` даёт непустое и различное русское сообщение без
следов SQL), `telegram-webhook-handler` (401 без заголовка, 401 с неверным
секретом, обработка не запускается до проверки секрета, безопасное
логирование при ошибке), `telegram-callbacks` (переходы `booking_sessions`
на моках репозиториев, `answerCallbackQuery` вызывается всегда — включая
случай, когда обработчик бросает исключение, — устаревшая кнопка, чужой
`appointmentId`, `SLOT_TAKEN` при подтверждении).

Интеграционные (`tests/integration/telegram-bot-flow.test.ts`, реальный
PostgreSQL — как и `booking-functions.test.ts`, напрямую теми же SQL-
операциями, что выполняют репозитории, под `service_role`, т.к. локально
нет поднятого PostgREST для реального `supabase-js`): upsert клиента без
затирания полей `null`, создание/восстановление/полная замена
`booking_sessions`, очистка сессии после брони, повторная доставка одного
`update_id` (конфликт `23505`), **параллельная** доставка одного `update_id`
на двух независимых подключениях (ровно один claim успешен), release+повторный
claim, подмена `appointmentId` чужой записи (0 строк), список только своих
будущих подтверждённых записей, `SLOT_TAKEN` (`23P01`) при повторном
бронировании занятого слота, и полный сценарий от `/start` до появления
записи в «моих записях».

## Локальный запуск

Требуется Node.js 24 LTS версии из `.nvmrc` (используйте `nvm use`); та же
версия закреплена в `engines.node` в `package.json`.

```bash
npm install
cp .env.example .env.local
# заполните .env.local реальными значениями
npm run dev
```

Приложение будет доступно на http://localhost:3000.

## Команды проверки

```bash
npm run lint              # ESLint
npm run typecheck         # проверка типов TypeScript
npm run test               # unit-тесты (алиас test:unit)
npm run test:unit          # unit-тесты (Vitest, tests/unit)
npm run test:sql           # SQL/pgTAP-тесты на локальной базе (нужен PostgreSQL + pgtap)
npm run test:integration   # настоящий конкурентный тест (нужен TEST_DATABASE_URL)
npm run test:all           # test:unit && test:sql && test:integration
npm run build               # production build

npm run telegram:webhook:info     # текущая конфигурация webhook (getWebhookInfo)
npm run telegram:webhook:set      # зарегистрировать webhook (после HTTPS-деплоя)
npm run telegram:webhook:delete   # удалить webhook (--drop-pending-updates — явный сброс очереди)
npm run telegram:commands:set     # зарегистрировать список команд бота в Telegram
```

Все `telegram:*` команды — ручные CLI-утилиты (`scripts/telegram/`), они
никогда не запускаются автоматически (не часть `dev`/`build`/`test`) и
требуют реальных `TELEGRAM_BOT_TOKEN`/`NEXT_PUBLIC_APP_URL`/
`TELEGRAM_WEBHOOK_SECRET` в `.env.local` — подробности в разделе "Этап 3:
Telegram-бот".

## Дальнейшие этапы

1. ~~База данных и безопасность (миграции, RLS, GRANT).~~ Готово.
2. ~~Механизм доступности и атомарное бронирование
   (`get_available_slots`, `reserve_appointment`, `cancel_appointment_by_client`).~~
   Готово.
3. ~~Telegram-бот и клиентский сценарий записи.~~ Готово.
4. Авторизация и административная панель.
5. Напоминания.
6. Полное тестирование (unit, SQL, integration, Playwright).
7. CI/CD и деплой на Vercel.
8. Финальное портфолио-оформление.

Подробности каждого этапа — в техническом задании проекта.
