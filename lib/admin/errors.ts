/**
 * Доменные ошибки административных RPC (Этап 4), тот же принцип, что и в
 * lib/booking/errors.ts: стабильный код на клиенте, сырой текст/SQLSTATE
 * PostgreSQL наружу не утекает.
 */

export const ADMIN_ERROR_CODES = [
  "NOT_ADMIN",
  "APPOINTMENT_NOT_FOUND",
  "INVALID_STATUS_TRANSITION",
  "INVALID_BLOCK_RANGE",
  "SCHEDULE_BLOCK_NOT_FOUND",
  "INTERNAL_ERROR",
] as const;

export type AdminErrorCode = (typeof ADMIN_ERROR_CODES)[number];

/**
 * SQLSTATE -> доменный код.
 *   42501       — стандартный insufficient_privilege, поднимается вручную в
 *                 admin_* функциях с текстом NOT_ADMIN, когда is_admin()
 *                 возвращает false.
 *   PB009       — переиспользован из ядра бронирования (то же значение:
 *                 запись не найдена).
 *   PB014/PB015/PB016 — см. supabase/migrations/20260717090000_...,
 *                 20260717090400_....
 */
const SQLSTATE_TO_ADMIN_CODE: Record<string, AdminErrorCode> = {
  "42501": "NOT_ADMIN",
  PB009: "APPOINTMENT_NOT_FOUND",
  PB014: "INVALID_STATUS_TRANSITION",
  PB015: "INVALID_BLOCK_RANGE",
  PB016: "SCHEDULE_BLOCK_NOT_FOUND",
};

export const ADMIN_ERROR_MESSAGES: Record<AdminErrorCode, string> = {
  NOT_ADMIN: "У вас нет прав администратора для этого действия.",
  APPOINTMENT_NOT_FOUND: "Запись не найдена — возможно, она уже была изменена.",
  INVALID_STATUS_TRANSITION:
    "Такой переход статуса недопустим (статус уже был изменён кем-то ещё — обновите страницу).",
  INVALID_BLOCK_RANGE: "Время окончания блокировки должно быть позже времени начала.",
  SCHEDULE_BLOCK_NOT_FOUND: "Блокировка не найдена — возможно, она уже была удалена.",
  INTERNAL_ERROR: "Внутренняя ошибка. Попробуйте ещё раз.",
};

export interface PostgresErrorLike {
  code?: string | null;
  message?: string | null;
}

export class AdminActionError extends Error {
  readonly code: AdminErrorCode;

  constructor(code: AdminErrorCode, options?: { cause?: unknown }) {
    super(ADMIN_ERROR_MESSAGES[code], options);
    this.name = "AdminActionError";
    this.code = code;
  }
}

export function toAdminError(error: PostgresErrorLike | unknown): AdminActionError {
  if (error instanceof AdminActionError) {
    return error;
  }

  const pgError = error as PostgresErrorLike;
  const mapped = pgError?.code ? SQLSTATE_TO_ADMIN_CODE[pgError.code] : undefined;

  if (mapped) {
    return new AdminActionError(mapped, { cause: error });
  }

  console.error("[admin] Необработанная ошибка административного действия:", error);
  return new AdminActionError("INTERNAL_ERROR", { cause: error });
}
