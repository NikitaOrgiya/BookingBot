import { GrammyError, HttpError } from "grammy";

/**
 * Политика повторов доставки напоминания. Максимум 5 попыток, задержки
 * между ними — 1 минута, 5 минут, 15 минут, 1 час (4 задержки для 5
 * попыток). Решение "это финальная неудача или ещё один retry и с какой
 * задержкой" принимается здесь, в TypeScript (юнит-тестируемо без БД), а
 * не в SQL — supabase/migrations/20260719100100_appointment_reminder_functions.sql
 * лишь атомарно применяет уже готовое решение
 * (mark_appointment_reminder_failed).
 *
 * Абсолютный exactly-once между PostgreSQL и внешним Telegram API
 * технически недостижим: соединение может оборваться уже ПОСЛЕ того, как
 * Telegram реально отправил сообщение, но ДО того, как наш процесс успел
 * зафиксировать mark_appointment_reminder_sent. В этом (редком) случае
 * следующая попытка claim увидит строку снова как pending/processing
 * (после истечения lease) и отправит напоминание повторно — клиент может
 * получить его дважды. Это единственный источник дублей в системе и он
 * задокументирован намеренно, а не скрыт: см. README/runbook, раздел
 * "Этап 5" -> "Редкий сценарий ambiguous delivery". Никакого технического
 * способа исключить его нет без двухфазного протокола на стороне Telegram,
 * которого Bot API не предоставляет.
 */

export const MAX_REMINDER_ATTEMPTS = 5;

/** Секунды задержки ПЕРЕД попыткой N+1, индекс = N-1 (после провала попытки N). */
const BACKOFF_SECONDS = [60, 300, 900, 3600] as const;

/** Верхняя граница, которой мы доверяем Telegram-заголовку retry_after (сек). */
const MAX_RETRY_AFTER_SECONDS = 3600;

/** true, если attemptCount (значение ПОСЛЕ текущего захвата) исчерпал лимит попыток. */
export function isTerminalAttempt(attemptCount: number): boolean {
  return attemptCount >= MAX_REMINDER_ATTEMPTS;
}

/**
 * Секунды до следующей попытки после провала попытки номер attemptCount.
 * retryAfterSeconds (из Telegram 429 Too Many Requests) имеет приоритет
 * над стандартным расписанием — Telegram явно указывает, сколько ждать,
 * это не наша эвристика, а требование самого API. Значение ограничено
 * сверху на случай аномально большого/некорректного retry_after.
 */
export function computeNextAttemptDelaySeconds(
  attemptCount: number,
  retryAfterSeconds?: number
): number {
  if (retryAfterSeconds !== undefined && retryAfterSeconds > 0) {
    return Math.min(retryAfterSeconds, MAX_RETRY_AFTER_SECONDS);
  }
  const index = Math.min(
    Math.max(attemptCount - 1, 0),
    BACKOFF_SECONDS.length - 1
  );
  return BACKOFF_SECONDS[index];
}

export interface ErrorClassification {
  /** false — постоянная ошибка (например, чат не найден, бот заблокирован
   * пользователем): дальнейшие попытки бессмысленны, отправка
   * прекращается немедленно, а не после исчерпания всех 5 попыток. */
  retryable: boolean;
  /** Заполнено только для Telegram 429 Too Many Requests. */
  retryAfterSeconds?: number;
}

/**
 * Классифицирует ошибку вызова Telegram Bot API (grammY):
 *   - GrammyError 429            -> retryable, с retry_after от Telegram;
 *   - GrammyError 5xx            -> retryable (временная проблема на
 *                                   стороне Telegram);
 *   - GrammyError 400/403/404    -> НЕ retryable (некорректный запрос,
 *                                   бот заблокирован, чат не найден —
 *                                   retry не исправит эти случаи);
 *   - GrammyError с другим кодом -> retryable (неизвестный случай,
 *                                   безопаснее дать шанс на повтор);
 *   - HttpError (сетевая ошибка) -> retryable (временная проблема сети);
 *   - что угодно иное            -> retryable (не Telegram-специфично,
 *                                   но ограничено тем же MAX_REMINDER_ATTEMPTS).
 */
export function classifyTelegramError(error: unknown): ErrorClassification {
  if (error instanceof GrammyError) {
    if (error.error_code === 429) {
      return {
        retryable: true,
        retryAfterSeconds: error.parameters?.retry_after,
      };
    }
    if (error.error_code >= 500) {
      return { retryable: true };
    }
    if ([400, 403, 404].includes(error.error_code)) {
      return { retryable: false };
    }
    return { retryable: true };
  }
  if (error instanceof HttpError) {
    return { retryable: true };
  }
  return { retryable: true };
}

const MAX_ERROR_MESSAGE_LENGTH = 500;

/**
 * Безопасный код ошибки для last_error_code — никогда сырой текст
 * исключения (см. lib/telegram/safe-error-code.ts — тот же принцип).
 */
export function extractSafeErrorCode(error: unknown): string {
  if (error instanceof GrammyError) {
    return `TELEGRAM_${error.error_code}`;
  }
  if (error instanceof HttpError) {
    return "TELEGRAM_NETWORK_ERROR";
  }
  return "INTERNAL_ERROR";
}

/**
 * Безопасное, ограниченное по длине диагностическое сообщение для
 * last_error_message. НИКОГДА не использует message/URL исходной ошибки
 * напрямую: HttpError оборачивает сетевую ошибку fetch, чьё сообщение
 * может содержать полный URL запроса (а значит и Telegram Bot Token —
 * часть пути `https://api.telegram.org/bot<TOKEN>/sendMessage`).
 * Единственный источник текста — GrammyError.description, которое
 * Telegram формирует сам как человекочитаемое объяснение ошибки API
 * ("Forbidden: bot was blocked by the user" и т.п.) и которое по
 * определению не содержит токен, chat_id, имя или иные персональные
 * данные клиента.
 */
export function extractSafeErrorMessage(error: unknown): string {
  const raw =
    error instanceof GrammyError
      ? `Telegram API ${error.error_code}: ${error.description}`
      : "Не удалось отправить сообщение (сетевая или внутренняя ошибка).";

  return raw.length > MAX_ERROR_MESSAGE_LENGTH
    ? `${raw.slice(0, MAX_ERROR_MESSAGE_LENGTH - 1)}…`
    : raw;
}
