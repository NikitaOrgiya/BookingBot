import "server-only";
import { getServiceSupabaseClient } from "@/lib/supabase/server-client";

/**
 * Явная конечная модель состояний диалога бронирования. Совместима с
 * фактической схемой booking_sessions (Этап 1): step — свободный text без
 * CHECK-ограничения в БД, поэтому весь набор допустимых значений
 * контролируется здесь, на уровне приложения.
 *
 *   idle              — нет активного сценария бронирования.
 *   choosing_service  — показан список услуг, ждём выбора.
 *   choosing_date     — услуга выбрана, показан список дат.
 *   choosing_slot     — дата выбрана, показан список свободных времён.
 *   confirming        — время выбрано, показан экран подтверждения.
 */
export const BOOKING_SESSION_STEPS = [
  "idle",
  "choosing_service",
  "choosing_date",
  "choosing_slot",
  "confirming",
] as const;

export type BookingSessionStep = (typeof BOOKING_SESSION_STEPS)[number];

export interface BookingSessionState {
  step: BookingSessionStep;
  selectedServiceId: string | null;
  selectedDate: string | null; // YYYY-MM-DD, локальная дата бизнеса
  selectedLocalTime: string | null; // HH:MM:SS, локальное время бизнеса
}

export const IDLE_SESSION_STATE: BookingSessionState = {
  step: "idle",
  selectedServiceId: null,
  selectedDate: null,
  selectedLocalTime: null,
};

// Сессия считается недействительной через 30 минут бездействия — после
// этого срока пользователь должен начать сценарий заново, а не продолжить
// с места, где остановился (устаревшая для него самого информация о
// слотах и расписании).
const SESSION_TTL_MINUTES = 30;

function isKnownStep(value: string): value is BookingSessionStep {
  return (BOOKING_SESSION_STEPS as readonly string[]).includes(value);
}

interface BookingSessionRow {
  step: string;
  selected_service_id: string | null;
  selected_date: string | null;
  selected_local_time: string | null;
  expires_at: string;
}

/**
 * Читает текущее состояние сессии клиента. Отсутствующая, повреждённая
 * (нераспознанный step — например, оставшийся от будущей несовместимой
 * версии бота) или просроченная (expires_at в прошлом) сессия безопасно
 * трактуется как idle; просроченная строка при этом удаляется.
 */
export async function getBookingSession(
  telegramUserId: string
): Promise<BookingSessionState> {
  const supabase = getServiceSupabaseClient();
  const { data, error } = await supabase
    .from("booking_sessions")
    .select("step, selected_service_id, selected_date, selected_local_time, expires_at")
    .eq("telegram_user_id", telegramUserId)
    .maybeSingle<BookingSessionRow>();

  if (error) {
    throw new Error(`Не удалось прочитать booking_session: ${error.message}`, {
      cause: error,
    });
  }
  if (!data) {
    return IDLE_SESSION_STATE;
  }

  if (new Date(data.expires_at).getTime() <= Date.now()) {
    await clearBookingSession(telegramUserId);
    return IDLE_SESSION_STATE;
  }

  if (!isKnownStep(data.step)) {
    // Несовместимый/повреждённый step — безопасно сбрасываем, а не
    // пытаемся угадать, что он означает.
    await clearBookingSession(telegramUserId);
    return IDLE_SESSION_STATE;
  }

  return {
    step: data.step,
    selectedServiceId: data.selected_service_id,
    selectedDate: data.selected_date,
    selectedLocalTime: data.selected_local_time,
  };
}

/**
 * Полностью заменяет состояние сессии клиента (не частичный patch):
 * каждый переход обязан явно указать все четыре поля, чтобы при переходе
 * "назад" нельзя было случайно оставить значение с более позднего шага.
 * expires_at продлевается от текущего момента при каждой записи.
 */
export async function setBookingSession(
  telegramUserId: string,
  state: BookingSessionState
): Promise<void> {
  const supabase = getServiceSupabaseClient();
  const expiresAt = new Date(
    Date.now() + SESSION_TTL_MINUTES * 60_000
  ).toISOString();

  const { error } = await supabase.from("booking_sessions").upsert(
    {
      telegram_user_id: telegramUserId,
      step: state.step,
      selected_service_id: state.selectedServiceId,
      selected_date: state.selectedDate,
      selected_local_time: state.selectedLocalTime,
      expires_at: expiresAt,
    },
    { onConflict: "telegram_user_id" }
  );

  if (error) {
    throw new Error(`Не удалось сохранить booking_session: ${error.message}`, {
      cause: error,
    });
  }
}

/**
 * Удаляет сессию клиента — вызывается после успешного бронирования, после
 * явной отмены сценария (/cancel, кнопка "Отменить") и лениво для
 * просроченных сессий в getBookingSession.
 */
export async function clearBookingSession(
  telegramUserId: string
): Promise<void> {
  const supabase = getServiceSupabaseClient();
  const { error } = await supabase
    .from("booking_sessions")
    .delete()
    .eq("telegram_user_id", telegramUserId);

  if (error) {
    throw new Error(`Не удалось очистить booking_session: ${error.message}`, {
      cause: error,
    });
  }
}
