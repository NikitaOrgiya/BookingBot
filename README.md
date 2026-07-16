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

**Намеренно не реализовано пока:** Telegram-бот, административная панель,
авторизация, напоминания. Эти части будут добавлены на следующих этапах
согласно техническому заданию.

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

scripts/
  test-sql.sh            прогон SQL/pgTAP-тестов на локальной базе
                          (сюда же лягут скрипты настройки Telegram webhook)

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

`BUSINESS_TIMEZONE` проверяется не просто как непустая строка, а как
настоящий IANA-идентификатор часового пояса — значение должно входить в
`Intl.supportedValuesOf("timeZone")`. Опечатки (`Europe/Moskow`), смещения
(`UTC+3`, `GMT+3`) и сокращённые названия городов (`Moscow`) отклоняются
ещё на этапе проверки окружения, а не приводят к тихим ошибкам при расчёте
расписания.

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
```

## Дальнейшие этапы

1. ~~База данных и безопасность (миграции, RLS, GRANT).~~ Готово.
2. ~~Механизм доступности и атомарное бронирование
   (`get_available_slots`, `reserve_appointment`, `cancel_appointment_by_client`).~~
   Готово.
3. Telegram-бот.
4. Авторизация и административная панель.
5. Напоминания.
6. Полное тестирование (unit, SQL, integration, Playwright).
7. CI/CD и деплой на Vercel.
8. Финальное портфолио-оформление.

Подробности каждого этапа — в техническом задании проекта.
