import "server-only";
import { redirect } from "next/navigation";
import { createAuthServerClient } from "@/lib/supabase/auth-server-client";

export interface AdminUser {
  id: string;
  email: string | null;
}

/**
 * Единственный источник истины "администратор ли текущий пользователь".
 * Каждая страница app/admin/** и каждый административный Server Action
 * обязаны вызвать эту функцию в начале своего выполнения — proxy.ts эту
 * проверку не выполняет и не заменяет (см. proxy.ts).
 *
 * Шаги:
 *   1. supabase.auth.getUser() — обращается к Supabase Auth и подтверждает
 *      пользователя по токену; данным, пришедшим только из браузера
 *      (например, из клиентского состояния), здесь не доверяем.
 *   2. public.is_admin() вызывается ЧЕРЕЗ клиент с JWT именно этого
 *      пользователя (не через service-role) — тот же самый RLS/SECURITY
 *      DEFINER путь, что и у всей остальной панели, без отдельной "теневой"
 *      проверки прав в коде приложения.
 *   3. Любой не-администратор (в том числе валидный, но отсутствующий в
 *      admin_users authenticated-пользователь) получает redirect на
 *      /login с общим кодом ошибки — is_admin() возвращает только
 *      true/false и не раскрывает содержимое admin_users вызывающему.
 */
export async function requireAdmin(): Promise<AdminUser> {
  const supabase = await createAuthServerClient();

  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser();

  if (userError || !user) {
    redirect("/login");
  }

  const { data: isAdmin, error: adminError } = await supabase.rpc("is_admin");

  if (adminError || !isAdmin) {
    redirect("/login?error=forbidden");
  }

  return { id: user.id, email: user.email ?? null };
}
