import { createClient } from "@supabase/supabase-js";
import { Client } from "pg";
import { getE2eEnv } from "./env";

/**
 * Создаёт (идемпотентно) тестового администратора ТОЛЬКО в локальном
 * Supabase-стеке — см. tests/e2e/env.ts:getE2eEnv() про защиту от
 * production-адреса. Если переменные окружения не заданы (например, нет
 * Docker для `supabase start`), setup молча ничего не делает — каждый
 * spec-файл сам проверяет их наличие и пропускает свои тесты
 * (`test.skip(...)`), а не притворяется, что что-то проверил.
 *
 * Два шага, как и в README (раздел "Создание первого
 * production-администратора"), только автоматически и локально:
 *   1. auth.admin.createUser() — email+пароль в Supabase Auth (GoTrue).
 *   2. INSERT в public.admin_users по прямому подключению к PostgreSQL —
 *      эта таблица недоступна вообще никому, кроме SECURITY DEFINER
 *      is_admin(), поэтому только так, не через Supabase-клиент.
 */
export default async function globalSetup(): Promise<void> {
  const env = getE2eEnv();
  if (!env) {
    console.warn(
      "[e2e] E2E_SUPABASE_URL/E2E_SUPABASE_SERVICE_ROLE_KEY/E2E_SUPABASE_PUBLISHABLE_KEY/" +
        "TEST_DATABASE_URL не заданы — тестовый администратор не создаётся, " +
        "все E2E-тесты пропустят себя сами (см. tests/e2e/README.md)."
    );
    return;
  }

  const supabaseAdmin = createClient(env.supabaseUrl, env.supabaseServiceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  async function ensureUser(email: string, password: string): Promise<string> {
    const { data: created, error: createError } = await supabaseAdmin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    });
    if (!createError) {
      return created.user.id;
    }
    // Уже существует с прошлого локального прогона — находим и продолжаем
    // (идемпотентно, без падения).
    const { data: listed, error: listError } = await supabaseAdmin.auth.admin.listUsers();
    if (listError) {
      throw new Error(
        `[e2e] createUser(${email}) упал (${createError.message}), а listUsers тоже: ${listError.message}`
      );
    }
    const existing = listed.users.find((u) => u.email === email);
    if (!existing) {
      throw new Error(`[e2e] Не удалось создать/найти пользователя ${email}: ${createError.message}`);
    }
    return existing.id;
  }

  const adminUserId = await ensureUser(env.adminEmail, env.adminPassword);
  // Пользователь существует в Supabase Auth, но НЕ добавляется в
  // admin_users — используется в auth.spec.ts для сценария "неадминистратор
  // не получает доступ".
  await ensureUser(env.nonAdminEmail, env.nonAdminPassword);

  const pg = new Client({ connectionString: env.databaseUrl });
  await pg.connect();
  try {
    await pg.query(
      `insert into public.admin_users (user_id) values ($1) on conflict (user_id) do nothing`,
      [adminUserId]
    );
  } finally {
    await pg.end();
  }

  console.log(
    `[e2e] Тестовые пользователи готовы: администратор ${env.adminEmail}, не-администратор ${env.nonAdminEmail}`
  );
}
