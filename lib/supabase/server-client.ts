import "server-only";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { getEnv } from "@/lib/env";

/**
 * Серверный привилегированный Supabase-клиент.
 *
 * Работает на secret-ключе (sb_secret_...), который обходит RLS. Импорт
 * "server-only" (первая строка) гарантирует, что сборка Next.js упадёт с
 * ошибкой, если этот модуль случайно попадёт в клиентский бандл — секрет
 * физически не может утечь в браузер через этот файл.
 *
 * Клиент сознательно НЕ хранит сессию и НЕ обновляет токены: у него нет и
 * не должно быть пользовательской сессии, чтобы Authorization-заголовок
 * привилегированного ключа никогда не был подменён пользовательским JWT.
 * Именно поэтому публичный и серверный клиенты — это два разных модуля, а
 * не один общий клиент с переключаемой авторизацией.
 *
 * Клиент создаётся лениво (при первом обращении), а не при импорте модуля:
 * так простой импорт для проверки server-only-границы не требует наличия
 * всех серверных переменных окружения.
 */

let cachedClient: SupabaseClient | undefined;

export function getServiceSupabaseClient(): SupabaseClient {
  if (cachedClient) {
    return cachedClient;
  }

  const env = getEnv();

  cachedClient = createClient(
    env.NEXT_PUBLIC_SUPABASE_URL,
    env.SUPABASE_SECRET_KEY,
    {
      auth: {
        // Никакой пользовательской сессии на сервере: секретный ключ —
        // это не пользователь, а привилегированная роль.
        persistSession: false,
        autoRefreshToken: false,
        detectSessionInUrl: false,
      },
      global: {
        headers: {
          // Явно помечаем источник запросов серверного бота для аудита в
          // логах Supabase.
          "X-Client-Info": "bookingbot-server",
        },
      },
    }
  );

  return cachedClient;
}
