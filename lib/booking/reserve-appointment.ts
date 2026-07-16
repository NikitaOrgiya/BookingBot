import "server-only";
import { getServiceSupabaseClient } from "@/lib/supabase/server-client";
import {
  reserveAppointmentInputSchema,
  type ReserveAppointmentInput,
} from "./schemas";
import { BookingError, toBookingError, type PostgresErrorLike } from "./errors";
import { mapAppointmentRow, type Appointment, type AppointmentRow } from "./types";

/**
 * Атомарно бронирует слот. Snapshot услуги (имя, длительность, цена) и
 * end_at вычисляются на стороне базы из актуальной услуги — клиентский код
 * их не передаёт и не может подделать. Финальная защита от конкурентного
 * двойного бронирования — exclusion constraint на appointments (23P01),
 * который здесь преобразуется в доменный код SLOT_TAKEN.
 *
 * Бросает BookingError с одним из кодов: TELEGRAM_USER_NOT_FOUND,
 * SERVICE_NOT_FOUND, SERVICE_INACTIVE, INVALID_START_TIME,
 * MIN_NOTICE_NOT_MET, OUTSIDE_BOOKING_HORIZON, OUTSIDE_WORKING_HOURS,
 * SCHEDULE_BLOCKED, SLOT_TAKEN, INTERNAL_ERROR.
 */

const DEADLOCK_DETECTED = "40P01";

/**
 * Конкурентная вставка пересекающихся интервалов в appointments защищена
 * GiST exclusion constraint — под нагрузкой это документированное свойство
 * PostgreSQL (не баг этого проекта): конкурирующие транзакции могут
 * захватывать блокировки страниц GiST-индекса в разном порядке и попасть в
 * честный deadlock, который PostgreSQL резолвит через 40P01
 * (deadlock_detected) вместо штатного 23P01 в момент коммита. Эмпирически
 * (см. README и tests/integration/reserve-appointment-race.test.ts) это
 * происходит примерно в четверти-трети реальных гонок за один слот — не
 * редкий крайний случай.
 *
 * PostgreSQL полностью откатывает транзакцию-жертву deadlock (никакого
 * частично применённого состояния не остаётся), поэтому повтор ВСЕЙ
 * RPC-операции reserve_appointment безопасен — это не "досрочный", а
 * абсолютно чистый повторный вызов, эквивалентный тому, как если бы этот
 * запрос просто пришёл на несколько миллисекунд позже (см. тесты в
 * tests/unit/booking-reserve-appointment.test.ts, подтверждающие как
 * "повтор -> успех", так и "повтор -> 23P01 -> SLOT_TAKEN").
 *
 * Максимум 3 попытки (1 исходная + до 2 повторов) — намеренно небольшое
 * число: если 40P01 повторяется даже после двух повторов подряд, это,
 * скорее всего, устойчивая конкуренция за тот же самый слот, и с точки
 * зрения пользователя это неотличимо от проигрыша гонки по 23P01 (см. ниже
 * трактовку исчерпанных повторов). Бесконечный/большой retry только
 * удерживал бы HTTP-запрос бота дольше, не меняя исход для пользователя.
 */
const MAX_RESERVE_ATTEMPTS = 3;

/**
 * Небольшой bounded backoff с джиттером между повторами. Конфликт — это
 * блокировка страниц GiST-индекса во время самой вставки, а не что-то,
 * требующее долгого ожидания (в отличие от, например, exponential backoff
 * при rate limiting) — проигравшая (сдёрнутая как жертва deadlock)
 * транзакция уже полностью откатилась и освободила все свои локи к
 * моменту, когда RPC вернул ошибку, поэтому достаточно единиц-десятков
 * миллисекунд, чтобы разойтись с конкурентом по времени начала следующей
 * попытки.
 */
function deadlockRetryDelayMs(attempt: number): number {
  const base = 15 * attempt;
  const jitter = Math.floor(Math.random() * 15);
  return base + jitter;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function reserveAppointment(
  input: ReserveAppointmentInput
): Promise<Appointment> {
  const parsed = reserveAppointmentInputSchema.parse(input);
  const supabase = getServiceSupabaseClient();

  let lastError: PostgresErrorLike | undefined;

  for (let attempt = 1; attempt <= MAX_RESERVE_ATTEMPTS; attempt += 1) {
    const { data, error } = await supabase.rpc("reserve_appointment", {
      p_telegram_user_id: parsed.telegramUserId,
      p_service_id: parsed.serviceId,
      p_start_at: parsed.startAt,
      p_client_note: parsed.clientNote ?? null,
    });

    if (!error) {
      if (!data) {
        throw toBookingError(
          new Error("reserve_appointment вернул пустой результат")
        );
      }
      return mapAppointmentRow(data as AppointmentRow);
    }

    lastError = error;

    const isDeadlock = error.code === DEADLOCK_DETECTED;
    const hasAttemptsLeft = attempt < MAX_RESERVE_ATTEMPTS;
    if (!isDeadlock || !hasAttemptsLeft) {
      break;
    }

    // Исходная ошибка сохраняется в toBookingError(...).cause только для
    // финального броска — здесь достаточно безопасного (без персональных
    // данных и без сырого текста PostgreSQL) диагностического лога.
    console.error(
      "[booking] reserve_appointment: обнаружен deadlock (40P01), повтор всей RPC-операции",
      { attempt, maxAttempts: MAX_RESERVE_ATTEMPTS }
    );
    await delay(deadlockRetryDelayMs(attempt));
  }

  if (lastError?.code === DEADLOCK_DETECTED) {
    // Повторы исчерпаны, и последняя попытка снова упала deadlock'ом.
    // Это решение принимается ЛОКАЛЬНО здесь, а не добавлением 40P01 в
    // общий sqlstateToBookingCode (lib/booking/errors.ts) — 40P01 вне
    // reserveAppointment (например, в cancelAppointmentByClient) НЕ
    // должен автоматически становиться SLOT_TAKEN, у него может быть
    // совсем другая причина. Но именно в reserveAppointment единственная
    // конкурентная точка — это вставка в appointments с exclusion
    // constraint, и deadlock здесь семантически неотличим с точки зрения
    // пользователя от "кто-то другой только что занял этот слот" (23P01):
    // в обоих случаях эта попытка не создала запись, и правильный ответ
    // пользователю — SLOT_TAKEN со свежим списком слотов, а не
    // непрозрачная INTERNAL_ERROR.
    console.error(
      "[booking] reserve_appointment: 40P01 после исчерпания повторов, трактуем как конфликт бронирования (SLOT_TAKEN)",
      { maxAttempts: MAX_RESERVE_ATTEMPTS }
    );
    throw new BookingError("SLOT_TAKEN", "SLOT_TAKEN", { cause: lastError });
  }

  throw toBookingError(lastError);
}
