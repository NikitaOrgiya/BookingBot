import "server-only";
import { z } from "zod";

/**
 * Единственный источник правды для переменных окружения сервера.
 * Импорт "server-only" гарантирует, что сборка Next.js упадёт с ошибкой,
 * если этот модуль случайно попадёт в клиентский бандл (например, через
 * компонент с "use client").
 *
 * Публичные NEXT_PUBLIC_* переменные тоже описаны здесь для валидации,
 * но клиентские компоненты должны читать их напрямую из
 * process.env.NEXT_PUBLIC_*, а не импортировать этот файл.
 */

const ianaTimeZones = new Set(Intl.supportedValuesOf("timeZone"));

function isValidIanaTimeZone(value: string): boolean {
  return ianaTimeZones.has(value);
}

const envSchema = z.object({
  NEXT_PUBLIC_APP_URL: z
    .string({ message: "NEXT_PUBLIC_APP_URL обязателен" })
    .url("NEXT_PUBLIC_APP_URL должен быть корректным URL"),
  NEXT_PUBLIC_SUPABASE_URL: z
    .string({ message: "NEXT_PUBLIC_SUPABASE_URL обязателен" })
    .url("NEXT_PUBLIC_SUPABASE_URL должен быть корректным URL"),
  // Современная схема ключей Supabase: publishable-ключ (sb_publishable_...)
  // заменяет устаревший anon-ключ. Он низкопривилегированный и может
  // попадать в браузер — им пользуется только публичный клиент.
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: z
    .string({ message: "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY обязателен" })
    .min(1, "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY не может быть пустым"),

  // Secret-ключ (sb_secret_...) заменяет устаревший service_role-ключ.
  // Он обходит RLS и обязан оставаться строго серверным: используется
  // только привилегированным клиентом в lib/supabase/server-client.ts,
  // который импортирует "server-only" и физически не может попасть в
  // клиентский бандл.
  SUPABASE_SECRET_KEY: z
    .string({ message: "SUPABASE_SECRET_KEY обязателен" })
    .min(1, "SUPABASE_SECRET_KEY не может быть пустым"),

  TELEGRAM_BOT_TOKEN: z
    .string({ message: "TELEGRAM_BOT_TOKEN обязателен" })
    .min(1, "TELEGRAM_BOT_TOKEN не может быть пустым"),
  TELEGRAM_BOT_USERNAME: z
    .string({ message: "TELEGRAM_BOT_USERNAME обязателен" })
    .min(1, "TELEGRAM_BOT_USERNAME не может быть пустым"),
  TELEGRAM_WEBHOOK_SECRET: z
    .string({ message: "TELEGRAM_WEBHOOK_SECRET обязателен" })
    .min(1, "TELEGRAM_WEBHOOK_SECRET не может быть пустым"),

  CRON_SECRET: z
    .string({ message: "CRON_SECRET обязателен" })
    .min(1, "CRON_SECRET не может быть пустым"),
  BUSINESS_TIMEZONE: z
    .string({ message: "BUSINESS_TIMEZONE обязателен" })
    .min(1, "BUSINESS_TIMEZONE не может быть пустым")
    .refine(isValidIanaTimeZone, {
      message:
        "BUSINESS_TIMEZONE должен быть настоящим IANA-идентификатором часового пояса (например, Europe/Moscow), а не смещением (UTC+3) или сокращённым/ошибочным названием",
    }),
});

export type Env = z.infer<typeof envSchema>;

function formatIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => `  - ${issue.path.join(".") || "(root)"}: ${issue.message}`)
    .join("\n");
}

/**
 * Чистая функция парсинга — принимает произвольный объект переменных,
 * ничего не кэширует. Используется для unit-тестов и для реального
 * process.env во время выполнения.
 */
export function parseEnv(raw: Record<string, string | undefined>): Env {
  const result = envSchema.safeParse(raw);
  if (!result.success) {
    throw new Error(
      `Некорректная конфигурация окружения:\n${formatIssues(result.error)}`
    );
  }
  return result.data;
}

let cachedEnv: Env | undefined;

/**
 * Ленивая проверка process.env. Вызывается только там, где переменные
 * реально нужны (Telegram webhook, cron, admin-роуты и т.д.), а не при
 * каждом импорте модуля — иначе сборка падала бы даже для страниц,
 * которым секреты не нужны.
 */
export function getEnv(): Env {
  if (!cachedEnv) {
    cachedEnv = parseEnv(process.env);
  }
  return cachedEnv;
}
