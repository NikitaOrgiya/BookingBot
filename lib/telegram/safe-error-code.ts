/**
 * Извлекает стабильный, безопасный для логов код ошибки — без текста
 * исключения, который может содержать детали БД, персональные данные
 * клиента или иные внутренние подробности. Используется и webhook-route
 * (безопасное логирование необработанных ошибок), и идемпотентным
 * middleware (last_error_code при release_telegram_update).
 */
export function safeErrorCode(err: unknown): string {
  const inner = (err as { error?: unknown } | undefined)?.error ?? err;
  if (
    inner &&
    typeof inner === "object" &&
    "code" in inner &&
    typeof (inner as { code: unknown }).code === "string"
  ) {
    return (inner as { code: string }).code;
  }
  return "INTERNAL_ERROR";
}
