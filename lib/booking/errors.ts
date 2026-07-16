/**
 * Доменные ошибки ядра бронирования.
 *
 * Единый стабильный набор кодов, одинаковый во всём проекте и покрытый
 * тестами. Сырые сообщения PostgreSQL клиенту не показываются: серверный
 * слой ловит ошибку RPC, сопоставляет её SQLSTATE с доменным кодом и
 * пробрасывает BookingError с этим кодом. Исходная ошибка сохраняется в
 * `cause` (для диагностики и серверного лога), но не утекает наружу.
 */

export const BOOKING_ERROR_CODES = [
  "SERVICE_NOT_FOUND",
  "SERVICE_INACTIVE",
  "TELEGRAM_USER_NOT_FOUND",
  "INVALID_START_TIME",
  "OUTSIDE_BOOKING_HORIZON",
  "MIN_NOTICE_NOT_MET",
  "OUTSIDE_WORKING_HOURS",
  "SCHEDULE_BLOCKED",
  "SLOT_TAKEN",
  "APPOINTMENT_NOT_FOUND",
  "APPOINTMENT_NOT_OWNED",
  "CANCELLATION_TOO_LATE",
  "ALREADY_CANCELLED",
  "APPOINTMENT_NOT_CANCELLABLE",
  "INTERNAL_ERROR",
] as const;

export type BookingErrorCode = (typeof BOOKING_ERROR_CODES)[number];

/**
 * Сопоставление PostgreSQL SQLSTATE -> доменный код.
 *
 * Кастомные коды класса 'PB' поднимаются функциями ядра бронирования
 * (см. supabase/migrations/20260716130100_booking_functions.sql). Нативный
 * 23P01 (exclusion_violation) — это конкурентное двойное бронирование,
 * пойманное exclusion constraint, и он преобразуется в SLOT_TAKEN.
 */
const SQLSTATE_TO_CODE: Record<string, BookingErrorCode> = {
  PB001: "SERVICE_NOT_FOUND",
  PB002: "SERVICE_INACTIVE",
  PB003: "TELEGRAM_USER_NOT_FOUND",
  PB004: "INVALID_START_TIME",
  PB005: "OUTSIDE_BOOKING_HORIZON",
  PB006: "MIN_NOTICE_NOT_MET",
  PB007: "OUTSIDE_WORKING_HOURS",
  PB008: "SCHEDULE_BLOCKED",
  PB009: "APPOINTMENT_NOT_FOUND",
  PB010: "APPOINTMENT_NOT_OWNED",
  PB011: "CANCELLATION_TOO_LATE",
  PB012: "ALREADY_CANCELLED",
  PB013: "APPOINTMENT_NOT_CANCELLABLE",
  "23P01": "SLOT_TAKEN",
};

export class BookingError extends Error {
  readonly code: BookingErrorCode;

  constructor(
    code: BookingErrorCode,
    message?: string,
    options?: { cause?: unknown }
  ) {
    super(message ?? code, options);
    this.name = "BookingError";
    this.code = code;
  }
}

/**
 * Минимальная форма ошибки RPC/PostgREST, из которой нам нужен только
 * SQLSTATE. Совпадает с полем `code` у PostgrestError и у ошибок пакета pg.
 */
export interface PostgresErrorLike {
  code?: string | null;
  message?: string | null;
}

export function sqlstateToBookingCode(
  sqlstate: string | null | undefined
): BookingErrorCode | undefined {
  if (!sqlstate) {
    return undefined;
  }
  return SQLSTATE_TO_CODE[sqlstate];
}

/**
 * Преобразует произвольную ошибку RPC в стабильную BookingError.
 * Известный SQLSTATE -> соответствующий доменный код; всё остальное ->
 * INTERNAL_ERROR. Исходная ошибка всегда сохраняется в `cause`, а также
 * логируется на сервере (диагностика без утечки текста клиенту).
 */
export function toBookingError(error: PostgresErrorLike | unknown): BookingError {
  if (error instanceof BookingError) {
    return error;
  }

  const pgError = error as PostgresErrorLike;
  const mapped = sqlstateToBookingCode(pgError?.code ?? undefined);

  if (mapped) {
    return new BookingError(mapped, mapped, { cause: error });
  }

  // Неизвестная ошибка: не показываем сырой текст PostgreSQL клиенту,
  // но фиксируем на сервере для диагностики.
  console.error("[booking] Необработанная ошибка ядра бронирования:", error);
  return new BookingError("INTERNAL_ERROR", "INTERNAL_ERROR", { cause: error });
}
