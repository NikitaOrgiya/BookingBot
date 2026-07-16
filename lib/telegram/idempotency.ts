import "server-only";
import { getServiceSupabaseClient } from "@/lib/supabase/server-client";

/**
 * Модель claim/process/retry для идемпотентной обработки Telegram update
 * (см. supabase/migrations/20260716140000_processed_telegram_updates_claim_retry.sql).
 *
 *   claim   — атомарная попытка "занять" update_id через INSERT в
 *             processed_telegram_updates. Атомарность обеспечивает
 *             первичный ключ таблицы, а не проверка "сначала SELECT, потом
 *             INSERT": два параллельных запроса с одним update_id всегда
 *             дают ровно один успешный INSERT и один конфликт 23505,
 *             независимо от порядка выполнения.
 *   release — удаляет claim, если бизнес-действие не завершилось успешно,
 *             чтобы Telegram при повторной доставке (после 5xx) мог
 *             получить новую попытку, а не молчаливый "уже обработано".
 *
 * Успешно обработанный update НИКОГДА не освобождается — этот update_id
 * не будет обработан повторно, даже если Telegram зачем-то пришлёт его
 * снова.
 */

const UNIQUE_VIOLATION = "23505";

/**
 * Пытается заявить update_id. true — это первая попытка, обработку нужно
 * выполнить. false — update_id уже заявлен (параллельно обрабатывается
 * прямо сейчас или уже полностью обработан ранее) — обработку нужно
 * пропустить и ответить Telegram успехом без повторного бизнес-действия.
 */
export async function claimTelegramUpdate(updateId: number): Promise<boolean> {
  const supabase = getServiceSupabaseClient();
  const { error } = await supabase
    .from("processed_telegram_updates")
    .insert({ telegram_update_id: updateId });

  if (!error) {
    return true;
  }
  if (error.code === UNIQUE_VIOLATION) {
    return false;
  }
  throw new Error(
    `Не удалось зарегистрировать Telegram update ${updateId}: ${error.message}`,
    { cause: error }
  );
}

/**
 * Освобождает claim после неудачной обработки, разрешая повторную попытку
 * при следующей доставке того же update_id. Ошибки самого release
 * логируются вызывающим кодом (idempotencyMiddleware), а не здесь — но
 * пробрасываются, чтобы вызывающий код знал, что "откат" не удался.
 */
export async function releaseTelegramUpdate(updateId: number): Promise<void> {
  const supabase = getServiceSupabaseClient();
  const { error } = await supabase
    .from("processed_telegram_updates")
    .delete()
    .eq("telegram_update_id", updateId);

  if (error) {
    throw new Error(
      `Не удалось освободить claim Telegram update ${updateId}: ${error.message}`,
      { cause: error }
    );
  }
}
