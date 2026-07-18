# E2E-тесты (Playwright)

Проверяют панель администратора через реальный браузер (Chromium) поверх
**локального** Next.js dev-сервера и **локального** Supabase-стека
(`supabase start`, требует Docker). Production Supabase и реальные записи
здесь никогда не используются — `tests/e2e/env.ts` явно отказывается
запускаться, если `E2E_SUPABASE_URL` не похож на `127.0.0.1`/`localhost`.

## Переменные окружения

Отдельный набор, не пересекающийся с `.env.local` приложения:

| Переменная | Назначение |
|---|---|
| `E2E_SUPABASE_URL` | URL локального Supabase (`http://127.0.0.1:54321` после `supabase start`) |
| `E2E_SUPABASE_SERVICE_ROLE_KEY` | Service-role ключ локального стека (`supabase status`) — только для создания тестового пользователя через Admin API |
| `E2E_SUPABASE_PUBLISHABLE_KEY` | Publishable/anon ключ локального стека — прокидывается в dev-сервер, поднимаемый Playwright |
| `TEST_DATABASE_URL` | Та же переменная, что и у `npm run test:integration` — прямое подключение к PostgreSQL для вставки в `admin_users` (эта таблица недоступна вообще никому, кроме `is_admin()`, поэтому не через Supabase-клиент) |
| `E2E_ADMIN_EMAIL` / `E2E_ADMIN_PASSWORD` | Необязательно — тестовый администратор (значения по умолчанию заданы) |
| `E2E_NON_ADMIN_EMAIL` / `E2E_NON_ADMIN_PASSWORD` | Необязательно — пользователь Supabase Auth без доступа к панели |

Если хотя бы одна из первых четырёх переменных не задана, `global-setup.ts`
ничего не делает, а каждый spec-файл сам пропускает свои тесты
(`test.skip(...)`) — не падает и не подделывает результат.

## Локальный запуск

```bash
supabase start                      # требует Docker
supabase db reset                   # применяет миграции + seed.sql

export E2E_SUPABASE_URL="http://127.0.0.1:54321"
export E2E_SUPABASE_SERVICE_ROLE_KEY="<service_role ключ из `supabase status`>"
export E2E_SUPABASE_PUBLISHABLE_KEY="<anon/publishable ключ из `supabase status`>"
export TEST_DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:54322/postgres"

npx playwright test
```

`playwright.config.ts` сам поднимает `npm run dev` на отдельном порту
(`PLAYWRIGHT_PORT`, по умолчанию 3100) с нужными `NEXT_PUBLIC_*`
переменными — отдельно поднимать dev-сервер не нужно.

## Известное ограничение этой песочницы/CI без Docker

В окружениях без Docker (`supabase start` недоступен) весь набор
самостоятельно пропускает себя — это ожидаемо, не тестовый долг. Полный
прогон возможен там, где есть Docker для локального Supabase-стека.
