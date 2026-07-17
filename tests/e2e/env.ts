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
 * Возвращает конфигурацию, если весь набор переменных присутствует, иначе
 * `null` — вызывающий код (global-setup и каждый spec) должен молча
 * пропустить работу, а не падать: локальный Supabase-стек (Docker) может
 * быть недоступен в песочнице/CI без Docker.
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
