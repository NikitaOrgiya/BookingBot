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
  **crash-safe lease-модели claim → complete / release** (`status`,
  `claim_token`, `locked_until`, миграция
  `20260716140000_processed_telegram_updates_claim_retry.sql`) — переживает
  аварийное завершение процесса (SIGKILL/serverless timeout) между claim и
  завершением, не только обычные исключения (см. раздел "Идемпотентность
  Telegram-обновлений" ниже);
- конкурентная гонка за слот, упавшая в `SQLSTATE 40P01` (deadlock,
  документированное поведение PostgreSQL под нагрузкой на GiST exclusion
  constraint), повторяется в `reserveAppointment` и в худшем случае даёт
  пользователю стабильный `SLOT_TAKEN`, а не `INTERNAL_ERROR` (см. раздел
  "40P01 (deadlock) при гонке за слот" ниже);
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

**Этап 4: авторизация и административная панель** — готово.

- `@supabase/ssr` вместо устаревшего `@supabase/auth-helpers-nextjs`: три
  разных клиента (`lib/supabase/browser-client.ts`,
  `lib/supabase/auth-server-client.ts`, `lib/supabase/proxy-client.ts`) —
  ни один из них не смешивается с service-role клиентом
  (`lib/supabase/server-client.ts`);
- `proxy.ts` в корне проекта (Next.js 16 заменил `middleware.ts` на
  `proxy.ts`) — только обновляет cookie сессии, не выполняет бизнес-
  авторизацию;
- `lib/auth/require-admin.ts` — единственный источник истины "администратор
  ли пользователь", вызывается на каждой странице `app/admin/**` и в каждом
  административном Server Action; proxy эту проверку не заменяет;
- `/login` (email + пароль, без публичной регистрации), безопасный отказ
  неадминистратору, выход;
- новые миграции (`supabase/migrations/20260717*.sql`): безопасная функция
  `public.admin_change_appointment_status()` вместо широкого `UPDATE
  appointments` для `authenticated`; `DELETE` на `services` отозван у
  `authenticated` (только активация/деактивация); exclusion constraint
  против пересекающихся активных `working_hours`; `CHECK`-валидация
  `business_settings` (непустое имя, настоящий IANA timezone);
  `public.admin_create_schedule_block()` / `admin_update_schedule_block()` /
  `admin_preview_schedule_block_conflicts()` — локальное время блокировки
  преобразуется в `timestamptz` внутри PostgreSQL, а не в браузере/Vercel;
- страницы панели: dashboard, записи (фильтры, сортировка, пагинация,
  смена статуса), услуги (без физического удаления), расписание (недельные
  интервалы + разовые блокировки), настройки организации;
- unit/SQL/integration/Playwright-тесты нового функционала.

Подробности — в разделе "Этап 4: авторизация и административная панель"
ниже.

**Намеренно не реализовано пока:** автоматические напоминания клиентам и
связанный с ними cron. Появятся на следующем этапе согласно техническому
заданию.

## Production

- Production URL: https://booking-bot-gules.vercel.app
- Telegram-бот: [@booking_service_nk_bot](https://t.me/booking_service_nk_bot)

## Технологический стек

- Next.js (App Router) + React + TypeScript (strict)
- Tailwind CSS
- Supabase: PostgreSQL, Auth (`@supabase/ssr`), Row Level Security
- Telegram Bot API (grammY)
- Zod — валидация всех внешних данных
- Vitest — unit- и integration-тесты
- Playwright — E2E-тесты административной панели
- GitHub Actions + Vercel

## Структура каталогов

```text
app/                    Next.js App Router: страницы и API-роуты
  login/                страница входа администратора (page.tsx, actions.ts)
  admin/                административная панель (layout.tsx с requireAdmin(),
                          loading.tsx, error.tsx, page.tsx — dashboard)
    appointments/         список/фильтры/смена статуса записей
    services/             каталог услуг (создание/изменение/активность)
    schedule/              недельное расписание + разовые блокировки
    settings/              настройки организации
  api/telegram/webhook/  Telegram webhook (Route Handler, POST-only)
  api/cron/reminders/    endpoint напоминаний (заглушка — Этап 5)

components/
  admin/                компоненты админ-панели (sidebar, mobile-navigation,
                          status-badge, appointment-filters/table,
                          service-form, working-hours-form,
                          schedule-block-form, settings-form, action-button)

lib/
  booking/              логика доступности и бронирования
  telegram/              бот: bot.ts, context.ts, webhook-handler.ts,
                          callback-data.ts, keyboards.ts, messages.ts,
                          formatters.ts, screens.ts, respond.ts,
                          user-profile.ts, idempotency.ts,
                          handlers/ (commands.ts, callbacks.ts),
                          repositories/ (telegram-users, booking-sessions,
                          services, appointments, business-settings)
  admin/                 доменная логика панели: schemas.ts (Zod форм),
                          appointment-status.ts (допустимые переходы),
                          date-time.ts (границы дня/недели в timezone
                          бизнеса, IANA-валидация), errors.ts (доменные
                          коды административных RPC), business-settings.ts
  supabase/              клиенты Supabase: public-client (anon, легаси),
                          server-client (service-role, только бот/cron),
                          browser-client / auth-server-client /
                          proxy-client (`@supabase/ssr`, JWT пользователя)
  auth/                  require-admin.ts — проверка прав администратора
  env.ts                 Zod-валидация переменных окружения

proxy.ts                 Next.js 16: обновление cookie сессии Supabase Auth
                          (замена устаревшего middleware.ts)

scripts/
  test-sql.sh            прогон SQL/pgTAP-тестов на локальной базе
  telegram/               ручное управление Telegram-ботом (webhook, команды)

supabase/
  migrations/            SQL-миграции
  seed.sql               стартовые данные (business_settings, демо-каталог услуг)
  tests/                 SQL-тесты безопасности (pgTAP)

tests/
  unit/                  Vitest
  integration/           интеграционные тесты
  e2e/                   Playwright (global-setup.ts, env.ts, helpers.ts,
                          *.spec.ts, README.md)
```

`api/cron/reminders/` пока остаётся заглушкой (`.gitkeep`) — напоминания
не реализованы на этом этапе (см. "Дальнейшие этапы").

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
  успехом, второй — ошибкой `23P01` **или**, реже, `40P01` (см. следующий
  раздел). Подробности и переменные окружения — в разделе "SQL-тесты и
  настоящий конкурентный тест" ниже.

### 40P01 (deadlock) при гонке за слот: retry в reserveAppointment

Конкурентная вставка пересекающихся интервалов в таблицу с GiST exclusion
constraint под нагрузкой — документированное поведение PostgreSQL:
конкурирующие транзакции могут захватывать блокировки страниц GiST-индекса
в разном порядке и попасть в честный deadlock, который PostgreSQL резолвит
через `SQLSTATE 40P01` (`deadlock_detected`) вместо штатного `23P01` в
момент коммита. Это не баг проекта и не редкий крайний случай — эмпирически
(см. "SQL-тесты и настоящий конкурентный тест" ниже) это происходит
примерно в **четверти-трети** реальных гонок за один слот.

Раньше `40P01` не был сопоставлен ни с одним доменным кодом в
`lib/booking/errors.ts` и утекал клиенту как `INTERNAL_ERROR` — вместо
`SLOT_TAKEN` пользователь видел непрозрачную ошибку, а `onConfirm` сбрасывал
весь `booking_session` (нужно было заново выбирать услугу/дату/время),
хотя семантически ситуация была ровно та же, что и при `23P01`: эта попытка
не создала запись, потому что кто-то опередил.

Исправление — **не** безусловное добавление `40P01 → SLOT_TAKEN` в общую
таблицу `SQLSTATE_TO_CODE` (это замаскировало бы реальные deadlock'и в
других, не связанных с гонкой за слот местах системы под тем же кодом), а
**локальный retry именно в `lib/booking/reserve-appointment.ts`**:

- при `SQLSTATE 40P01` вся RPC-операция `reserve_appointment` повторяется
  целиком (не что-то частичное) — до **3 попыток** (1 исходная + до 2
  повторов), с небольшим bounded backoff/джиттером (десятки миллисекунд)
  между попытками;
- повтор безопасен, потому что PostgreSQL полностью откатывает
  транзакцию-жертву deadlock: проигравший вызов не оставляет после себя
  никакого частично применённого состояния — повторный вызов эквивалентен
  тому, как если бы запрос просто пришёл на несколько миллисекунд позже;
- `23P01` по-прежнему преобразуется в `SLOT_TAKEN` без единого повтора (это
  окончательный, детерминированный исход — retry здесь ничего не изменил
  бы);
- если `40P01` повторяется даже после исчерпания всех попыток — это
  трактуется **локально, внутри `reserveAppointment`** как конфликт
  бронирования и тоже даёт `SLOT_TAKEN`: единственная конкурентная точка в
  этой функции — вставка в `appointments` с exclusion constraint, и с точки
  зрения пользователя устойчивый `40P01` неотличим от `23P01` (кто-то занял
  слот раньше);
- любой другой `SQLSTATE` (доменные `PBxxx`, неизвестные коды) по-прежнему
  не повторяется и ведёт себя как раньше — исправление не расширяет retry
  за пределы одной конкретной, понятной причины.

`cancelAppointmentByClient` и любые другие места, где теоретически может
возникнуть `40P01`, **не** получили такого же поведения — общий
`sqlstateToBookingCode` в `lib/booking/errors.ts` по-прежнему не знает про
`40P01` вообще, и он там не появится: за пределами `reserveAppointment` нет
основания трактовать deadlock как «слот занят».

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
ровно один запрос успешен, ровно один отклонён с `SQLSTATE 23P01` **или**,
реже, `40P01` (deadlock — см. "40P01 (deadlock) при гонке за слот" выше;
это сырой `INSERT` в обход `reserveAppointment`, поэтому здесь оба кода
легитимны — retry применяется только внутри `reserveAppointment`), что в
таблице реально осталась одна строка (не ноль, не две), и в конце удаляет
все созданные им данные. При 50 локальных прогонах этого сценария (raw
`reserve_appointment`, без прикладного retry) распределение — ориентировочно
**60-75% `23P01` / 25-40% `40P01`**, ровно один победитель в каждом прогоне.

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

Отдельный файл — `tests/integration/reserve-appointment-race.test.ts`, три
уровня проверки:

1. Настоящая конкурентная гонка **на самой функции** `reserve_appointment`
   (в отличие от `double-booking-race.test.ts`, который гоняет сырой
   `INSERT` напрямую в `appointments`) — сырой SQLSTATE, оба `23P01`/`40P01`
   легитимны здесь по той же причине, что и выше.
2. Чистая функция преобразования `23P01 → SLOT_TAKEN` на структуре ошибки
   ровно такой формы, какую реально бросил PostgreSQL в первом тесте.
3. **Конкурентная гонка через прикладной путь**: настоящий `reserveAppointment()`
   (со всей retry-логикой на `40P01`) вызывается напрямую 50 раз подряд, с
   замоканным ТОЛЬКО HTTP-транспортом supabase-js/PostgREST (которого в
   этой песочнице нет) — сама функция `.rpc()` мока выполняет ту же
   `reserve_appointment` через `pg.Pool` с несколькими физическими
   соединениями (для настоящей конкурентности на уровне PostgreSQL, а не
   последовательного выполнения на одном соединении). Проверяет ту самую
   гарантию, которую требовал корректирующий аудит: во всех 50 прогонах
   ровно один успех и один **стабильный `SLOT_TAKEN`**, ноль
   `INTERNAL_ERROR`, ровно одна запись в БД на слот в каждом прогоне.

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

### Идемпотентность Telegram-обновлений: crash-safe lease-модель

Telegram может повторно доставить один и тот же `update_id` (не получив
вовремя `200 OK`). **Корректирующий аудит Этапа 3** заменил исходную модель
claim/release на `DELETE` — она освобождала claim только в JS
`try/catch` и **никогда** не освобождала его, если процесс был убит
снаружи (SIGKILL, serverless timeout, деплой, OOM) между claim и
завершением обработки: такой `update_id` оставался «заявленным» навсегда,
и Telegram, повторно доставляя его, тихо не получал никакой обработки. Эта
проблема была найдена независимым аудитом (см. историю коммитов) и здесь
устранена полностью, а не смягчена.

Новая модель — **claim → complete / claim → release**, с *lease* (TTL), а
не безусловным «навечно занято» — реализована в
`lib/telegram/idempotency.ts` поверх трёх SQL-функций из миграции
`20260716140000_processed_telegram_updates_claim_retry.sql`
(`claim_telegram_update`, `complete_telegram_update`,
`release_telegram_update`).

**Схема `processed_telegram_updates`:**

| Колонка | Назначение |
|---|---|
| `telegram_update_id` (PK) | внешний `update_id` Telegram |
| `status` | `'processing'` — прямо сейчас (или ещё) обрабатывается; `'completed'` — обработан навсегда, повторно не выполняется |
| `claim_token` (uuid) | токен владения текущим claim — одноразовый, меняется при каждом (пере)захвате |
| `claimed_at` | момент последнего (пере)захвата |
| `locked_until` | **lease**: момент истечения текущего claim — после него claim можно перезахватить |
| `completed_at` | момент перехода в `completed` (`null`, пока `status='processing'`) |
| `attempt_count` | счётчик (пере)захватов — только для диагностики |
| `last_error_code` | безопасный код последней ошибки (`release_telegram_update`), без персональных данных |

**`claim_telegram_update(update_id, lease_seconds = 120)`** атомарно (через
`INSERT ... ON CONFLICT DO NOTHING` + `SELECT ... FOR UPDATE` на конфликте)
возвращает один из трёх исходов:

- **`claimed`** (+ новый `claim_token`) — новый `update_id`, либо ранее
  просроченный (`locked_until` в прошлом) claim перезахвачен. Caller обязан
  выполнить бизнес-действие.
- **`completed`** — уже успешно обработан ранее. Бизнес-действие
  пропускается, webhook отвечает `2xx`.
- **`busy`** — другой воркер владеет ещё не истёкшим lease прямо сейчас.
  webhook **не должен** отвечать `2xx` (Telegram решит, что обработано, и
  прекратит повторную доставку раньше времени) — см. ниже про `503`.

**Lease = 120 секунд** — намеренно с большим запасом относительно
фактического времени обработки одного update (upsert профиля, чтение/
запись `booking_session`, один RPC ядра бронирования, один ответ в
Telegram — обычно низкие сотни миллисекунд). Компромисс: достаточно долго,
чтобы не перехватить ещё живой (просто медленный) запрос, и достаточно
коротко, чтобы retry после реальной аварии не откладывался на
неопределённый срок.

**`claim_token` как защита от «ожившего» старого воркера.** И
`complete_telegram_update(update_id, claim_token)`, и
`release_telegram_update(update_id, claim_token, error_code?)` требуют
*точное* совпадение `claim_token` с тем, что реально сейчас владеет
claim'ом (и `status='processing'`) — иначе возвращают `false`, ничего не
меняя. Сценарий, который это предотвращает: воркер A завис на дольше, чем
lease; воркер B перезахватывает `update_id` (получает новый `claim_token`)
и успешно его обрабатывает; воркер A «оживает» и пытается
complete/release — его `claim_token` уже не совпадает с актуальным, поэтому
он не может ни завершить, ни (тем более) освободить чужой, уже
перезахваченный claim.

**`release_telegram_update`** (обычная, пойманная в JS ошибка обработки) не
удаляет строку и не переводит в `completed` — просто немедленно
«просрочивает» `locked_until = now()`, разрешая следующей доставке того же
`update_id` заявить его заново без ожидания исходного lease.
**Успешно завершённая (`completed`) строка не удаляется и не
перезахватывается никогда.**

`DELETE` для `service_role` на `processed_telegram_updates` больше не
нужен — новая модель использует только `SELECT`+`INSERT`+`UPDATE`, и
миграция явно отзывает `DELETE`, если он был. Как и раньше, миграция
**падает при применении**, если после `REVOKE`/`GRANT`
`anon`/`authenticated`/`PUBLIC` получили хоть какую-то привилегию на эту
таблицу или на новые функции, или если реальные привилегии `service_role`
разошлись с этой моделью. Права `anon`/`authenticated` не меняются вообще.

**Middleware** (`createIdempotencyMiddleware` в `lib/telegram/bot.ts`)
выполняет claim первым, до всего остального:

- `completed` → выходит немедленно, ничего не делая;
- `busy` → бросает `BusyTelegramUpdateError`;
- `claimed` → выполняет `next()` (весь дальнейший конвейер), затем
  `complete_telegram_update`; при исключении — `release_telegram_update` с
  безопасным кодом ошибки, и исходное исключение пробрасывается дальше.

**HTTP-поведение** (`lib/telegram/webhook-handler.ts`):

| Исход claim | HTTP-статус | Смысл для Telegram |
|---|---|---|
| `completed` | `2xx` | доставлено, повторов больше не нужно |
| `claimed`, успех | `2xx` | доставлено, обработано |
| `claimed`, ошибка | `5xx` | retryable — Telegram повторит доставку позже |
| `busy` (`BusyTelegramUpdateError`) | **`503`** | явно retryable, но НЕ «сбой обработки» — отдельный от `5xx` общего вида статус, чтобы в логах/метриках не путать «другой воркер уже занят» с реальной ошибкой |

**Аварийное восстановление, без искусственных допущений:** если процесс
убит снаружи (SIGKILL/serverless timeout/деплой) в любой момент между
`claimed` и `complete`/`release` — ни один из них не выполняется, но это и
не нужно: `locked_until` истекает сам, и следующая доставка того же
`update_id` (Telegram повторяет доставку, если не получил `2xx`) получает
`claimed` с новым `claim_token` через `claim_telegram_update`. Update не
теряется и не остаётся «похороненным» навсегда — единственное отличие от
доставки без аварии в том, что повтор ждёт истечения lease, а не приходит
мгновенно.

**Бизнес-эффекты повторной доставки после аварии** (окно «действие уже
выполнено, но `complete_telegram_update` не вызван») устранены отдельно, не
только на уровне идемпотентности update_id:

- **Бронь.** Если `reserveAppointment` при повторной доставке confirm-
  колбэка получает `SLOT_TAKEN`, `onConfirm` (`lib/telegram/handlers/
  callbacks.ts`) сначала проверяет через `getOwnConfirmedAppointmentBySlot`
  (`lib/telegram/repositories/appointments.ts`), нет ли у **этого же**
  клиента уже confirmed-записи на тот же `service_id`/`start_at`. Если
  есть — это не «слот заняли», это его собственная запись из предыдущей
  (не дошедшей до `complete_telegram_update`) попытки: показывается тот же
  успешный экран, идемпотентно, без повторного бронирования и без ложного
  «слот занят». Если своей записи нет — слот действительно занят кем-то
  другим, показываются свежие слоты (обычный путь `SLOT_TAKEN`).
- **Отмена.** Если `cancelAppointmentByClient` при повторной доставке
  cancel-колбэка получает `ALREADY_CANCELLED`, `onCancelConfirmed`
  трактует это как безопасный идемпотентный успех (тот же текст, что и при
  первой успешной отмене), а не как ошибку. `ALREADY_CANCELLED` в принципе
  недостижим для чужой записи: `cancel_appointment_by_client` проверяет
  владение **до** проверки статуса — подмена `appointmentId` по-прежнему
  даёт `APPOINTMENT_NOT_OWNED`, не раскрывая и не изменяя чужую запись.

**Ограничение, которое остаётся честно не решённым (и не решается без
transactional outbox):** *точно один раз* доставить пользователю сообщение
в Telegram в принципе невозможно без transactional outbox — после
аварии, если бизнес-действие уже выполнено, а `complete_telegram_update` не
вызван, повторная доставка update может привести к повторной попытке
ответить пользователю (например, повторному `editMessageText` с тем же
текстом успеха). Это не баг: сама бизнес-операция (бронь/отмена) не
дублируется и не теряется — гарантия распространяется на данные, а не на
кратность именно исходящего сообщения Telegram.

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
с фактически невыполненным действием. Отдельно от общего `5xx`: если
idempotency-middleware сигнализирует `busy` (другой воркер уже владеет
lease на этот `update_id` — см. следующий раздел), ответ — `503`, тоже
retryable для Telegram, но осознанно отличимый в логах/метриках от
настоящего сбоя обработки.

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

Unit (`tests/unit/telegram-*.test.ts` и `tests/unit/booking-reserve-
appointment.test.ts`, без БД и без сети):
`telegram-callback-data` (кодек, unknown action, невалидный UUID/дата/
datetime/страница, лимит в 64 байта), `telegram-user-profile` (немедленная
конвертация id в строку), `telegram-formatters` (дата/время/длительность/
цена в конкретном часовом поясе — не в серверном), `telegram-messages`
(каждый `BookingErrorCode` даёт непустое и различное русское сообщение без
следов SQL), `telegram-webhook-handler` (401 без заголовка, 401 с неверным
секретом, обработка не запускается до проверки секрета, безопасное
логирование при ошибке, **503 при `BusyTelegramUpdateError`**),
`telegram-bot-idempotency` (диспетчеризация `createIdempotencyMiddleware`
на моках `claim/complete/releaseTelegramUpdate`: `claimed`→`next()`+
`complete` с тем же `claim_token`, `completed`→`next()` не вызывается,
`busy`→бросает `BusyTelegramUpdateError` без вызова `next()`, ошибка в
`next()`→`release` с тем же `claim_token` и пробрасывание исходной ошибки,
`complete`/`release`, вернувшие `false` из-за неактуального токена, не
бросают исключение), `telegram-callbacks` (переходы `booking_sessions` на
моках репозиториев, `answerCallbackQuery` вызывается всегда — включая
случай, когда обработчик бросает исключение, — устаревшая кнопка, чужой
`appointmentId`, `SLOT_TAKEN` при подтверждении **и его идемпотентный
вариант** — если своя confirmed-запись на тот же слот уже существует,
показывается успех, а не ложный `SLOT_TAKEN`, **`ALREADY_CANCELLED`→
идемпотентный успех отмены**, но `APPOINTMENT_NOT_OWNED` по-прежнему даёт
обычную ошибку), `booking-reserve-appointment` (мок только транспорта
`getServiceSupabaseClient().rpc`: `40P01`→повтор→успех, `40P01`→повтор→
`23P01`→`SLOT_TAKEN`, `40P01` на всех попытках→стабильный `SLOT_TAKEN`, не
`INTERNAL_ERROR`, прочие `SQLSTATE` не повторяются).

Интеграционные (`tests/integration/telegram-bot-flow.test.ts`, реальный
PostgreSQL — как и `booking-functions.test.ts`, напрямую теми же SQL-
операциями, что выполняют репозитории, под `service_role`, т.к. локально
нет поднятого PostgREST для реального `supabase-js`): upsert клиента без
затирания полей `null`, создание/восстановление/полная замена
`booking_sessions`, очистка сессии после брони, полный набор сценариев
crash-safe lease-модели claim/complete/release (`claimed`/`completed`/
`busy`, **параллельная** доставка одного `update_id` на двух независимых
подключениях — ровно один `claimed`, другой `busy`, истечение lease и
перезахват с новым `claim_token`, старый `claim_token` не может ни
complete, ни release перезахваченный claim, обычная ошибка → release →
немедленный re-claim, симулированная авария — claim без complete/release —
не хоронит update навсегда), бизнес-эффекты повтора после аварии (созданный
appointment обнаруживается повторно через тот же запрос, что и
`getOwnConfirmedAppointmentBySlot`, — не дублируется; повторная отмена
после аварии безопасно завершается как `ALREADY_CANCELLED`, владение
по-прежнему проверяется), подмена `appointmentId` чужой записи (0 строк),
список только своих будущих подтверждённых записей, `SLOT_TAKEN`
(`23P01`) при повторном бронировании занятого слота, и полный сценарий от
`/start` до появления записи в «моих записях».

`tests/integration/reserve-appointment-race.test.ts` дополнительно содержит
конкурентную гонку **через прикладной путь** — настоящий
`reserveAppointment()` (включая retry на `40P01`) вызывается против
реального конкурентного PostgreSQL (замокан только HTTP-транспорт
supabase-js/PostgREST на `pg.Pool` с несколькими физическими соединениями,
не сама гонка) 50 раз подряд: каждый раз ровно один успех и один
стабильный `SLOT_TAKEN`, ноль `INTERNAL_ERROR`, ровно одна запись в БД на
слот.

## Этап 4: авторизация и административная панель

Цель этапа — чтобы владельцу бизнеса для повседневного управления
BookingBot больше не был нужен Supabase Studio: вход, записи, услуги,
расписание и настройки организации редактируются через собственную панель
на `/admin/**`.

### Supabase Auth SSR — три разных клиента

Устаревший `@supabase/auth-helpers-nextjs` не используется — только
актуальный `@supabase/ssr`. В проекте теперь четыре Supabase-клиента,
каждый для своей задачи, и они **никогда не смешиваются**:

| Клиент | Файл | Ключ | Где используется |
|---|---|---|---|
| Публичный (легаси) | `lib/supabase/public-client.ts` | publishable | не используется панелью |
| Браузерный | `lib/supabase/browser-client.ts` | publishable | клиентские auth-действия |
| Серверный SSR (пользовательский) | `lib/supabase/auth-server-client.ts` | publishable + JWT из cookie | Server Components/Actions панели |
| Proxy | `lib/supabase/proxy-client.ts` | publishable | `proxy.ts` (обновление cookie) |
| Service-role | `lib/supabase/server-client.ts` | secret | только Telegram-бот и локальный тестовый setup |

Административная панель обращается к данным **исключительно** через
`auth-server-client.ts` — с JWT реального авторизованного пользователя, а
не секретным ключом. Это значит, что каждый запрос панели реально проходит
через RLS-политики (`is_admin()` и т.д.), а не обходит их: баг в
`requireAdmin()` не мог бы "случайно" открыть чужие данные, потому что
последнее слово всё равно за базой данных, а не за проверкой в коде
приложения.

### Почему admin UI не использует service role

Три причины:

1. **Дефолт в пользу RLS.** Если бы панель читала данные через
   `server-client.ts` (secret-ключ, обходит RLS), то единственной защитой
   от "обычный пользователь увидел записи другого бизнеса/чужие данные"
   был бы код приложения (`requireAdmin()`). Один пропущенный вызов на
   одной странице — и утечка. С `auth-server-client.ts` этот же баг ничего
   не даёт: RLS-политика (`using (public.is_admin())`) всё равно вернёт 0
   строк неадминистратору, вне зависимости от того, что "забыл" сделать
   код страницы.
2. **Единая модель прав.** Telegram-бот и панель обращаются к БД
   принципиально разными способами (service-role с полным доверием к
   серверному коду vs. authenticated + RLS с проверкой на каждый запрос) —
   смешивать их в одном клиенте означало бы, что баг в панели может
   получить привилегии бота, и наоборот.
3. **Явная граница ответственности.** `lib/supabase/server-client.ts`
   импортирует `server-only` и физически не может попасть в клиентский код
   — но ничто не мешало бы серверному коду панели ошибочно импортировать
   именно его вместо `auth-server-client.ts`. Разные имена файлов и разные
   директории (`lib/auth/require-admin.ts` использует только
   `auth-server-client.ts`) делают такую путаницу видимой при код-ревью.

### proxy.ts вместо middleware.ts

Next.js 16 переименовал соглашение `middleware.ts` в `proxy.ts` (тот же
API — файл в корне проекта, `export default` функция, `NextRequest` →
`NextResponse`, опциональный `config.matcher`). `proxy.ts` в этом проекте:

- обновляет access/refresh token cookie Supabase Auth на каждом подходящем
  запросе (`supabase.auth.getUser()`, не `getSession()` — обращается к
  серверу Auth и валидирует токен, а не просто читает claims из cookie);
- **не выполняет бизнес-авторизацию** и не считает наличие cookie
  доказательством административного доступа — это единственная задача
  `requireAdmin()` (`lib/auth/require-admin.ts`), вызываемого отдельно на
  каждой странице `app/admin/**` и в каждом административном Server
  Action;
- пропускает `api/telegram/webhook` и `api/cron/*` (они работают через
  `service_role`/секретные токены, а не пользовательскую cookie-сессию), а
  также статику.

### requireAdmin()

`lib/auth/require-admin.ts`:

1. `supabase.auth.getUser()` — подтверждает пользователя у самого
   Supabase Auth (не доверяет данным, пришедшим только из браузера);
2. вызывает `public.is_admin()` через клиент с JWT именно этого
   пользователя — тот же RLS/`SECURITY DEFINER` путь, каким пользуется
   весь остальной проект, без отдельной "теневой" проверки прав в коде
   приложения;
3. любой не-администратор (в том числе валидный, но отсутствующий в
   `admin_users` пользователь) получает `redirect("/login?error=forbidden")`
   — `is_admin()` возвращает только `true`/`false` и не раскрывает
   содержимое `admin_users`.

`app/admin/layout.tsx` вызывает `requireAdmin()` и помечен
`export const dynamic = "force-dynamic"` — административные страницы не
кешируются и не генерируются статически как общедоступный контент.

### `/login`

`app/login/page.tsx` + `app/login/actions.ts`. Публичной регистрации нет
(ни страницы, ни ссылки). Пароль нигде не логируется. Ошибка формы и
ошибка "неверный email/пароль" от Supabase Auth сведены к одному сообщению
(`invalid_credentials`) — иначе поведение раскрывало бы, существует ли
такой email. Авторизованный администратор, открывший `/login`, сразу
перенаправляется в `/admin`; авторизованный, но не-администратор
получает отдельное сообщение (`forbidden`) и разлогинивается — сессия
панели не остаётся висеть у пользователя, которому там нечего делать.

### Новые административные RPC (миграции `20260717*`)

Как и в Этапе 2, каждая функция — фиксированный `search_path`, полные имена
объектов, `REVOKE ALL` + точечный `GRANT EXECUTE`, стабильные доменные
коды ошибок (`lib/admin/errors.ts`).

- **`public.admin_change_appointment_status(id, new_status, reason)`** —
  единственный способ изменить статус записи. До этой миграции
  `authenticated` имел широкий `UPDATE` на `appointments`; теперь этот
  `GRANT` отозван (`revoke update on table public.appointments from
  authenticated`), а политика `appointments_admin_update` удалена как
  структурно бесполезная. Функция (`SECURITY DEFINER`) сама проверяет
  `is_admin()`, блокирует строку `FOR UPDATE`, разрешает только
  `confirmed → {completed, cancelled, no_show}` (никаких обратных или
  произвольных переходов), при отмене заполняет `cancelled_at`/
  `cancel_reason`, не даёт менять клиента/время/услугу/snapshot-поля.
- **Услуги:** `DELETE` отозван у `authenticated`
  (`20260717090100_services_restrict_delete.sql`) — физическое удаление
  услуги невозможно на уровне базы, не только на уровне UI; единственный
  способ "убрать" услугу — деактивировать (`is_active = false`), история
  `appointments` (snapshot-поля) не зависит от текущего состояния услуги.
- **`working_hours_no_overlap_active`** — exclusion constraint (GiST,
  `btree_gist`) запрещает пересекающиеся **активные** интервалы одного дня
  недели. Перед добавлением constraint миграция
  (`20260717090200_working_hours_no_overlap.sql`) сама ищет существующие
  конфликты и, если находит, падает с понятным сообщением и точным списком
  пар `id` вместо того, чтобы попытаться исправить данные автоматически —
  исправление всегда ручное (деактивировать один из интервалов или
  изменить его границы).
- **`business_settings`**: `public.is_valid_timezone()` (пробует `now() at
  time zone tz`, ловит исключение) + `CHECK` на настоящий IANA-идентификатор
  и на непустое `business_name`
  (`20260717090300_business_settings_validation.sql`).
- **`public.admin_create_schedule_block` / `admin_update_schedule_block`**
  — локальные дата + время блокировки преобразуются в `timestamptz`
  **внутри PostgreSQL**, читая `business_settings.timezone`, а не в
  браузере администратора или на сервере Vercel (иначе малейшее расхождение
  часовых поясов создало бы блокировку "не в то время").
  **`admin_preview_schedule_block_conflicts`** — чистое чтение,
  возвращает подтверждённые будущие записи, пересекающиеся с
  предполагаемой блокировкой; панель показывает это как предупреждение и
  требует явного подтверждения (чекбокс) перед сохранением, если конфликт
  есть — существующие `appointments` при этом не отменяются автоматически
  (осознанное решение MVP).

### Страницы панели

- **Dashboard** (`/admin`) — подтверждённые записи сегодня, записи и
  отменённые за текущую неделю, ближайшие записи, быстрые ссылки. Границы
  "сегодня"/"неделя" считаются в `business_settings.timezone`
  (`lib/admin/date-time.ts`), а не в timezone браузера/Vercel. Только
  счётчики (`count: "exact", head: true`) и один короткий список — без
  чтения всей таблицы `appointments`.
- **Записи** (`/admin/appointments`) — дата/время в timezone организации,
  snapshot услуги/длительности/цены, клиент (имя, `username`, Telegram ID),
  статус, заметка; фильтры (диапазон дат, статус, имя, username, Telegram
  ID), сортировка по времени, пагинация (20/страница). Статус меняется
  только через `admin_change_appointment_status`; отмена требует
  подтверждения; панель никогда не удаляет запись, не меняет время,
  клиента или snapshot услуги, не создаёт запись вручную.
- **Услуги** (`/admin/services`) — создание/изменение, активация/
  деактивация, порядок отображения. Цена вводится в рублях, в базу
  сохраняется в копейках (`lib/admin/schemas.ts: rublesToCents`). Кнопки
  "Удалить" нет — физическое удаление не реализовано ни в UI, ни на уровне
  прав БД.
- **Расписание** (`/admin/schedule`) — недельные интервалы (несколько в
  день, `0 = понедельник`) с активацией/деактивацией/удалением;
  пересечение активных интервалов отклоняется constraint'ом БД, ошибка
  показывается понятным сообщением. Разовые блокировки — локальные
  дата/время + причина, полный день или часть дня, предупреждение о
  пересечении с записями перед сохранением, список предстоящих блокировок,
  изменение/удаление будущих.
- **Настройки** (`/admin/settings`) — название, IANA timezone (с
  обязательным дополнительным подтверждением при изменении и явным
  пояснением, что абсолютный момент времени существующих записей не
  меняется, а вот отображаемое локальное время — да), горизонт
  бронирования, сроки уведомления/отмены, шаг слотов, поля напоминаний
  (редактируются, но помечены "Будет использоваться после подключения
  напоминаний" — сами напоминания на этом этапе не реализованы).

Изменения на этих страницах применяются немедленно: Telegram-бот и
`get_available_slots`/`reserve_appointment` читают те же таблицы напрямую,
без кеша и без necessity передеплоя.

### Создание первого production-администратора

Публичной регистрации нет — первый (и любой следующий) администратор
создаётся вручную:

1. Supabase Dashboard → Authentication → Users → **Add user** (email +
   пароль; либо пригласительное письмо, если в проекте настроен SMTP).
   Скопируйте `UUID` созданного пользователя.
2. Supabase Dashboard → SQL Editor, под ролью с доступом к записи в
   `public.admin_users` (например, через `service_role`/postgres-подключение
   в панели Supabase, **не** через саму административную панель — она
   намеренно не предоставляет UI для назначения администраторов):

   ```sql
   insert into public.admin_users (user_id) values ('<UUID пользователя>');
   ```
3. Войдите на `/login` этими email/паролем — `is_admin()` теперь вернёт
   `true`, панель откроется.

Отозвать доступ — `delete from public.admin_users where user_id =
'<UUID>';` (сам пользователь Supabase Auth при этом не удаляется).

### Локальный запуск auth для разработки

Полноценный локальный Supabase (Auth/GoTrue) требует Docker
(`supabase start`). Если Docker недоступен (как в некоторых песочницах
CI/агентов), автоматические тесты, не зависящие от реального Auth
(unit/SQL/pgTAP/integration через `pg`), по-прежнему работают в обычном
PostgreSQL — см. "SQL-тесты и настоящий конкурентный тест" выше. Для
ручной проверки UI входа/панели в браузере нужен один из двух вариантов:

- `supabase start` (локальный полный стек с Auth) + `supabase db reset`,
  затем создать локального тестового администратора тем же способом, что
  и в production (см. выше), но через `http://127.0.0.1:54321`;
- либо реальный (staging/production) Supabase-проект с уже настроенным
  `.env.local` (см. `.env.example`).

### Playwright

`@playwright/test` — конфигурация в `playwright.config.ts`, спецификации в
`tests/e2e/` (12 сценариев: неавторизованный доступ, неверный пароль,
отказ неадминистратору, вход/выход, dashboard, CRUD и деактивация услуг,
рабочие интервалы, разовые блокировки, фильтрация записей, смена
статуса). Тестовые пользователи (администратор и не-администратор) для
E2E создаются автоматически и **только** в локальном Supabase-стеке —
`tests/e2e/global-setup.ts` явно отказывается запускаться, если
`E2E_SUPABASE_URL` не похож на `127.0.0.1`/`localhost` (см.
`tests/e2e/README.md`). Production Supabase и реальные записи в E2E
никогда не используются. Без переменных окружения локального стека весь
набор аккуратно пропускает себя (`test.skip`), а не падает и не
подделывает результат — это подтверждено в этой репозитории (браузер
Chromium запускается, dev-сервер поднимается, все 12 тестов корректно
помечаются skipped при отсутствии `E2E_SUPABASE_URL` и т.д.), но полный
прогон с реальным Supabase Auth требует Docker (`supabase start`),
недоступного в некоторых песочницах.

```bash
npx playwright install --with-deps chromium   # один раз (если браузер ещё не установлен)
npm run test:e2e
```

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
npm run test:e2e          # Playwright (нужен локальный Supabase-стек, см. tests/e2e/README.md)
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
4. ~~Авторизация и административная панель.~~ Готово.
5. Напоминания.
6. Полное тестирование (unit, SQL, integration, Playwright) — базовый набор
   для Этапа 4 добавлен; продолжится на следующих этапах по мере роста
   функциональности.
7. CI/CD и деплой на Vercel — `.github/workflows/ci.yml` добавлен в рамках
   Этапа 4 (lint/typecheck/unit/build + отдельная job SQL/integration);
   автоматизация деплоя на Vercel — отдельная задача.
8. Финальное портфолио-оформление.

Подробности каждого этапа — в техническом задании проекта.
