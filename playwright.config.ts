import { defineConfig, devices } from "@playwright/test";

/**
 * E2E-конфигурация панели администратора. НИКОГДА не указывает на
 * production Supabase — только на локальный Supabase-стек
 * (`supabase start`) и локальный dev-сервер Next.js. См. tests/e2e/README.md
 * для переменных окружения и локального запуска.
 *
 * Тестовый администратор создаётся автоматически (tests/e2e/global-setup.ts)
 * ТОЛЬКО в локальной тестовой базе — глобальный setup явно отказывается
 * запускаться, если E2E_SUPABASE_URL похож на production-адрес.
 */

const PORT = Number(process.env.PLAYWRIGHT_PORT ?? 3100);
const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? `http://127.0.0.1:${PORT}`;

// Прокидываем локальные Supabase-переменные в dev-сервер, только если они
// реально заданы — иначе dev-сервер должен взять значения из .env.local,
// как обычно, а не получить принудительно пустую строку поверх них.
const webServerEnv: Record<string, string> = {};
if (process.env.E2E_SUPABASE_URL) {
  webServerEnv.NEXT_PUBLIC_SUPABASE_URL = process.env.E2E_SUPABASE_URL;
}
if (process.env.E2E_SUPABASE_PUBLISHABLE_KEY) {
  webServerEnv.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = process.env.E2E_SUPABASE_PUBLISHABLE_KEY;
}

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  // 0 (не только локально, но и в CI): ретраи размывали бы точный подсчёт
  // total/passed/failed/skipped, которым CI (.github/workflows/ci.yml,
  // job "playwright") проверяет, что все сценарии реально выполнились и
  // прошли — "flaky, но пересдано" не должно маскироваться под "passed".
  retries: 0,
  workers: 1,
  // JSON-репортер в CI — по нему workflow проверяет, что тестов реально
  // выполнено ожидаемое количество и что skipped/failed равны нулю (сам
  // Playwright возвращает код 0 и для "все тесты пропущены", поэтому
  // одного exit code недостаточно — см. ci.yml, шаг "Verify E2E results").
  reporter: process.env.CI
    ? [["github"], ["list"], ["json", { outputFile: "playwright-report/results.json" }]]
    : "list",
  globalSetup: "./tests/e2e/global-setup.ts",
  use: {
    baseURL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        // Песочницы/CI без предзагруженного Chromium последней сборки
        // Playwright используют уже установленный браузер по этому пути
        // (см. PLAYWRIGHT_BROWSERS_PATH), а не скачивают новый.
        launchOptions: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
          ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE }
          : undefined,
      },
    },
  ],
  webServer: {
    command: `npm run dev -- --port ${PORT}`,
    url: baseURL,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
    env: webServerEnv,
  },
});
