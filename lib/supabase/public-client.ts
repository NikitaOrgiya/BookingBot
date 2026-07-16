import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/**
 * Публичный низкопривилегированный Supabase-клиент.
 *
 * Использует publishable-ключ (sb_publishable_...), который безопасно
 * попадает в браузер: он подчиняется Row Level Security и не даёт доступа
 * к рабочим таблицам бота (anon/публичная роль в этой схеме не имеет
 * никаких табличных привилегий — см. README, раздел "RLS и GRANT").
 *
 * Этот модуль намеренно НЕ импортирует "server-only" и НЕ использует
 * secret-ключ: он предназначен и для клиентских компонентов тоже.
 * Привилегированные операции бронирования выполняются исключительно через
 * серверный клиент в ./server-client.ts.
 *
 * Публичные переменные читаются напрямую из process.env.NEXT_PUBLIC_*,
 * чтобы Next.js мог заинлайнить их в клиентский бандл (импортировать здесь
 * lib/env.ts нельзя — он server-only).
 */

let cachedClient: SupabaseClient | undefined;

export function getPublicSupabaseClient(): SupabaseClient {
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

  cachedClient = createClient(url, publishableKey);
  return cachedClient;
}
