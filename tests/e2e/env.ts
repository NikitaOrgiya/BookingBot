/**
 * Переменные окружения E2E-набора. Ни одна из них не пересекается с
 * .env.local production/dev-приложения — это отдельный, полностью
 * локальный контур (см. README.md в этой папке).
 */
export interface E2eEnv {
  supabaseUrl: string;
  supabaseServiceRoleKey: string;
  supabasePublishableKey: string;
  databaseUrl: string;
  adminEmail: string;
  adminPassword: string;
  nonAdminEmail: string;
  nonAdminPassword: string;
}

/**
 * Возвращает конфигурацию, если весь набор переменных присутствует.
 *
 * Поведение при отсутствии переменных зависит от `process.env.CI`
 * (GitHub Actions выставляет его автоматически, `CI=true`):
 *   - В CI это ошибка конфигурации, а не повод пропустить тесты: локальный
 *     Supabase-стек в CI обязателен (job поднимает его сама, см. ci.yml),
 *     поэтому отсутствие переменных означает, что стек не поднялся или
 *     значения не были прокинуты — функция бросает исключение, что валит
 *     весь прогон (а не тихо помечает 12 тестов как skipped).
 *   - Вне CI (ручной локальный запуск разработчиком без Docker/Supabase)
 *     возвращается `null` — вызывающий код (global-setup и каждый spec)
 *     пропускает работу без Docker, это осознанно разрешённый режим
 *     только для локальной ручной проверки.
 */
export function getE2eEnv(): E2eEnv | null {
  const supabaseUrl = process.env.E2E_SUPABASE_URL;
  const supabaseServiceRoleKey = process.env.E2E_SUPABASE_SERVICE_ROLE_KEY;
  const supabasePublishableKey = process.env.E2E_SUPABASE_PUBLISHABLE_KEY;
  const databaseUrl = process.env.TEST_DATABASE_URL;
  const adminEmail = process.env.E2E_ADMIN_EMAIL ?? "e2e-admin@example.test";
  const adminPassword = process.env.E2E_ADMIN_PASSWORD ?? "e2e-test-password-not-a-secret-123";
  const nonAdminEmail = process.env.E2E_NON_ADMIN_EMAIL ?? "e2e-non-admin@example.test";
  const nonAdminPassword =
    process.env.E2E_NON_ADMIN_PASSWORD ?? "e2e-test-password-not-a-secret-456";

  if (!supabaseUrl || !supabaseServiceRoleKey || !supabasePublishableKey || !databaseUrl) {
    const isCi = process.env.CI === "true" || process.env.CI === "1";
    if (isCi) {
      const missingNames = [
        !supabaseUrl && "E2E_SUPABASE_URL",
        !supabaseServiceRoleKey && "E2E_SUPABASE_SERVICE_ROLE_KEY",
        !supabasePublishableKey && "E2E_SUPABASE_PUBLISHABLE_KEY",
        !databaseUrl && "TEST_DATABASE_URL",
      ].filter(Boolean);
      throw new Error(
        `Отсутствуют обязательные переменные E2E-окружения в CI: ${missingNames.join(", ")}. ` +
          "В CI (process.env.CI=true) это ошибка конфигурации (локальный " +
          "Supabase-стек не поднялся или значения не были прокинуты в job) — " +
          "тесты не должны молча пропускаться."
      );
    }
    return null;
  }

  // Жёсткая защита: E2E никогда не должен коснуться production Supabase,
  // даже если кто-то по ошибке передаст боевые значения в окружение.
  const isLocal = /^https?:\/\/(127\.0\.0\.1|localhost|0\.0\.0\.0)([:/]|$)/.test(supabaseUrl);
  if (!isLocal) {
    throw new Error(
      `E2E_SUPABASE_URL ("${supabaseUrl}") не похож на локальный адрес (127.0.0.1/localhost). ` +
        "E2E-тесты запрещено запускать против production/staging Supabase."
    );
  }

  return {
    supabaseUrl,
    supabaseServiceRoleKey,
    supabasePublishableKey,
    databaseUrl,
    adminEmail,
    adminPassword,
    nonAdminEmail,
    nonAdminPassword,
  };
}
