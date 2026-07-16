import "server-only";
import { getServiceSupabaseClient } from "@/lib/supabase/server-client";

/**
 * Crash-safe lease-модель claim/complete/release для идемпотентной
 * обработки Telegram update (см. supabase/migrations/
 * 20260716140000_processed_telegram_updates_claim_retry.sql — там же
 * подробно описана мотивация: предыдущая модель claim/release на DELETE
 * освобождала claim только в JS try/catch и НИКОГДА не освобождала его,
 * если процесс был убит снаружи — SIGKILL, serverless timeout, деплой —
 * между claim и завершением обработки).
 *
 * Вся атомарность и вся защита от гонок реализованы в самих SQL-функциях
 * (row-level локи, claim_token как токен владения) — этот модуль только
 * тонко оборачивает три RPC-вызова типами, не добавляя собственной логики
 * консистентности.
 *
 *   claim   — claim_telegram_update(update_id, leaseSeconds). Три исхода:
 *               "claimed"   — update можно (нужно) обрабатывать, дан новый
 *                             claimToken;
 *               "completed" — update уже успешно обработан ранее, повторное
 *                             бизнес-действие не выполняется;
 *               "busy"      — другой воркер прямо сейчас владеет ещё не
 *                             истёкшим lease на этот update_id.
 *   complete — переводит update в 'completed' НАВСЕГДА (не освобождается и
 *              не может быть перезахвачен). Вызывается после успешного
 *              завершения ВСЕЙ обработки (бизнес-действие + ответ клиенту).
 *   release  — снимает lease после штатной (пойманной в JS) ошибки, чтобы
 *              следующая доставка того же update_id могла заявить его
 *              заново. НЕ используется для восстановления после
 *              аварийного завершения процесса — тот случай обрабатывает
 *              сам lease (locked_until), а не эта функция: зависший или
 *              убитый воркер просто не вызовет ни complete, ни release, и
 *              claim_telegram_update перезахватит update_id сам, как
 *              только lease истечёт.
 *
 * LEASE_SECONDS задаёт длительность lease с большим запасом относительно
 * фактического времени обработки одного update (upsert профиля, чтение/
 * запись booking_session, один RPC ядра бронирования, один ответ в
 * Telegram — обычно низкие сотни миллисекунд). 120 секунд — компромисс
 * между "не блокировать retry надолго после реальной аварии" и "не дать
 * медленному, но живому запросу быть ошибочно перезахваченным другим
 * воркером, пока он ещё работает".
 */

const LEASE_SECONDS = 120;

/**
 * Сигнализирует, что update_id прямо сейчас обрабатывается другим
 * воркером (ещё не истёкший lease). НЕ ошибка обработки — вызывающий код
 * (webhook-handler.ts) обязан отличать её от прочих исключений и отвечать
 * Telegram retryable-статусом (503), а не 200 (иначе Telegram решит, что
 * update обработан, и перестанет его повторно доставлять) и не 500
 * (семантически это не сбой, а временная занятость).
 */
export class BusyTelegramUpdateError extends Error {
  /** Безопасный код для safeErrorCode() (см. ./safe-error-code) — попадает
   * в лог webhook-handler.ts вместо generic "INTERNAL_ERROR". */
  readonly code = "TELEGRAM_UPDATE_BUSY";
  readonly updateId: number;

  constructor(updateId: number) {
    super(`Telegram update ${updateId} уже обрабатывается другим воркером`);
    this.name = "BusyTelegramUpdateError";
    this.updateId = updateId;
  }
}

export type ClaimResult =
  | { status: "claimed"; claimToken: string }
  | { status: "completed" }
  | { status: "busy" };

interface ClaimRpcRow {
  result: "claimed" | "completed" | "busy";
  claim_token: string | null;
}

/**
 * Заявляет (или перезахватывает просроченный) update_id. См. ClaimResult
 * для трактовки каждого исхода вызывающим кодом (lib/telegram/bot.ts).
 */
export async function claimTelegramUpdate(
  updateId: number,
  leaseSeconds: number = LEASE_SECONDS
): Promise<ClaimResult> {
  const supabase = getServiceSupabaseClient();
  const { data, error } = await supabase.rpc("claim_telegram_update", {
    p_telegram_update_id: updateId,
    p_lease_seconds: leaseSeconds,
  });

  if (error) {
    throw new Error(
      `Не удалось заявить (claim) Telegram update ${updateId}: ${error.message}`,
      { cause: error }
    );
  }

  const row = (Array.isArray(data) ? data[0] : data) as ClaimRpcRow | undefined;
  if (!row) {
    throw new Error(
      `claim_telegram_update вернул пустой результат для update ${updateId}`
    );
  }

  switch (row.result) {
    case "claimed":
      if (!row.claim_token) {
        throw new Error(
          `claim_telegram_update вернул result="claimed" без claim_token для update ${updateId}`
        );
      }
      return { status: "claimed", claimToken: row.claim_token };
    case "completed":
      return { status: "completed" };
    case "busy":
      return { status: "busy" };
    default:
      throw new Error(
        `claim_telegram_update вернул неизвестный result="${String(row.result)}" для update ${updateId}`
      );
  }
}

/**
 * Фиксирует успешное завершение обработки update_id. Возвращает false,
 * если claim_token уже не актуален (lease истёк и был перезахвачен другим
 * воркером до вызова complete) — бизнес-действие уже выполнено и отменить
 * его нельзя, поэтому вызывающий код (bot.ts) только логирует этот случай,
 * не бросает исключение и не повторяет действие.
 */
export async function completeTelegramUpdate(
  updateId: number,
  claimToken: string
): Promise<boolean> {
  const supabase = getServiceSupabaseClient();
  const { data, error } = await supabase.rpc("complete_telegram_update", {
    p_telegram_update_id: updateId,
    p_claim_token: claimToken,
  });

  if (error) {
    throw new Error(
      `Не удалось завершить (complete) Telegram update ${updateId}: ${error.message}`,
      { cause: error }
    );
  }

  return data === true;
}

/**
 * Освобождает lease после обычной (пойманной в JS) ошибки обработки,
 * позволяя следующей доставке того же update_id заявить его заново.
 * errorCode — безопасный внутренний код ошибки для диагностики (никогда
 * сырой текст исключения или персональные данные клиента).
 */
export async function releaseTelegramUpdate(
  updateId: number,
  claimToken: string,
  errorCode?: string
): Promise<boolean> {
  const supabase = getServiceSupabaseClient();
  const { data, error } = await supabase.rpc("release_telegram_update", {
    p_telegram_update_id: updateId,
    p_claim_token: claimToken,
    p_error_code: errorCode ?? null,
  });

  if (error) {
    throw new Error(
      `Не удалось освободить (release) claim Telegram update ${updateId}: ${error.message}`,
      { cause: error }
    );
  }

  return data === true;
}
