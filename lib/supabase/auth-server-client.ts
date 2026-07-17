import "server-only";
import { cookies } from "next/headers";
import { createServerClient } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getEnv } from "@/lib/env";

/**
 * Supabase-клиент для Server Components и Server Actions административной
 * панели, авторизованный JWT текущего пользователя из cookie сессии
 * Supabase Auth — НЕ secret-ключом. Запросы через этот клиент проходят RLS
 * как обычный authenticated-пользователь, поэтому политики, завязанные на
 * public.is_admin(), реально применяются. Это единственный способ, которым
 * панель администратора обращается к данным (см. lib/auth/require-admin.ts
 * и README, раздел "Почему admin UI не использует service role") —
 * lib/supabase/server-client.ts (secret-ключ, обходит RLS) для обычных
 * операций панели использовать запрещено.
 *
 * Создаётся заново на каждый вызов (а не кэшируется как service-клиент,
 * где это осознанно сделано в lib/supabase/server-client.ts): next/headers
 * cookies() привязаны к текущему запросу и не могут быть переиспользованы
 * между запросами разных пользователей.
 */
export async function createAuthServerClient(): Promise<SupabaseClient> {
  const env = getEnv();
  const cookieStore = await cookies();

  return createServerClient(
    env.NEXT_PUBLIC_SUPABASE_URL,
    env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options)
            );
          } catch {
            // Вызвано из Server Component при рендере (там разрешено
            // только читать cookie, не устанавливать) — безопасно
            // игнорируется: proxy.ts обновляет сессию на каждом запросе,
            // поэтому истёкший токен всё равно будет обновлён при
            // следующем переходе между страницами или Server Action.
          }
        },
      },
    }
  );
}
