import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

/**
 * Supabase-клиент для proxy.ts (Next.js 16, замена middleware.ts).
 *
 * Единственная задача — обновлять cookie сессии Supabase Auth на каждом
 * запросе. Читает переменные напрямую из process.env (а не через
 * lib/env.ts/getEnv()): proxy выполняется в облегчённом рантайме на
 * границе запроса, и ему намеренно не нужны серверные секреты
 * (SUPABASE_SECRET_KEY, TELEGRAM_*) — только два публичных значения.
 *
 * Не выполняет и не должен выполнять бизнес-авторизацию (проверку
 * "администратор ли пользователь") — только обновление токена. См.
 * proxy.ts и lib/auth/require-admin.ts.
 */
export function createProxySupabaseClient(request: NextRequest) {
  let response = NextResponse.next({ request });

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const publishableKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

  if (!url || !publishableKey) {
    throw new Error(
      "NEXT_PUBLIC_SUPABASE_URL/NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY не заданы"
    );
  }

  const supabase = createServerClient(url, publishableKey, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        cookiesToSet.forEach(({ name, value }) =>
          request.cookies.set(name, value)
        );
        response = NextResponse.next({ request });
        cookiesToSet.forEach(({ name, value, options }) =>
          response.cookies.set(name, value, options)
        );
      },
    },
  });

  return { supabase, response };
}
