import { createBrowserClient } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Supabase-клиент для клиентских (браузерных) auth-действий панели.
 * Использует publishable-ключ и управляет cookie сессии через
 * @supabase/ssr — синхронизировано по формату с серверными клиентами
 * (auth-server-client.ts, proxy-client.ts). Это НЕ то же самое, что
 * lib/supabase/public-client.ts: тот создаёт обычный клиент через
 * @supabase/supabase-js и не пишет/читает cookie в формате, которое
 * понимают SSR-клиенты, поэтому сессия, начатая им, не была бы видна
 * серверным Server Components.
 */
let cachedClient: SupabaseClient | undefined;

export function getBrowserSupabaseClient(): SupabaseClient {
  if (cachedClient) {
    return cachedClient;
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const publishableKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

  if (!url) {
    throw new Error("NEXT_PUBLIC_SUPABASE_URL не задан");
  }
  if (!publishableKey) {
    throw new Error("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY не задан");
  }

  cachedClient = createBrowserClient(url, publishableKey);
  return cachedClient;
}
