import type { NextRequest } from "next/server";
import { createProxySupabaseClient } from "@/lib/supabase/proxy-client";

/**
 * Next.js 16 использует "proxy.ts" вместо устаревшего "middleware.ts"
 * (см. https://nextjs.org/docs/messages/middleware-to-proxy).
 *
 * Единственная задача этой функции — обновлять cookie сессии Supabase Auth
 * (access/refresh token) на каждом подходящем запросе. Она НЕ выполняет
 * бизнес-авторизацию и НЕ решает, администратор ли пользователь: наличие
 * валидной cookie сессии доказывает только то, что кто-то вошёл в Supabase
 * Auth, а не то, что этот "кто-то" — администратор. Эту проверку выполняет
 * requireAdmin() (lib/auth/require-admin.ts), вызываемый отдельно на каждой
 * странице /admin/** и в каждом административном Server Action — proxy эту
 * проверку не заменяет.
 */
export default async function proxy(request: NextRequest) {
  const { supabase, response } = createProxySupabaseClient(request);

  // Обязательно getUser(), а не getSession(): getUser() обращается к
  // серверу Supabase Auth и валидирует токен, а не просто читает
  // непроверенные claims из cookie. Именно этот вызов триггерит обновление
  // истёкшего access token и запись нового значения в response (через
  // setAll в createProxySupabaseClient).
  await supabase.auth.getUser();

  return response;
}

export const config = {
  matcher: [
    /*
     * Пропускаем статику и служебные endpoint'ы, которым сессия Supabase
     * Auth не нужна и не должна подменяться: Telegram webhook работает по
     * X-Telegram-Bot-Api-Secret-Token, cron — по CRON_SECRET, оба через
     * service_role, а не через пользовательскую сессию браузера.
     */
    "/((?!_next/static|_next/image|favicon.ico|api/telegram|api/cron|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)",
  ],
};
