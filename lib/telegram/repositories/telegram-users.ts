import "server-only";
import { getServiceSupabaseClient } from "@/lib/supabase/server-client";

/**
 * Профиль клиента, полученный из свежего Telegram-update. Любое поле,
 * которого нет в конкретном update (например, у пользователя нет username),
 * должно передаваться как `undefined`, а не `null` — см. upsertTelegramUser.
 */
export interface TelegramUserProfile {
  telegramUserId: string;
  username?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  languageCode?: string | null;
}

interface TelegramUserRow {
  id: string;
}

/**
 * Регистрирует или обновляет профиль клиента в telegram_users. Возвращает
 * внутренний uuid строки (используется как FK в appointments и как ключ
 * владения для "мои записи").
 *
 * Важно: в итоговый payload включаются только поля, которые ПРИСУТСТВУЮТ в
 * этом конкретном update (не `undefined`). PostgREST выполняет upsert как
 * `INSERT ... ON CONFLICT (telegram_user_id) DO UPDATE SET <только
 * переданные столбцы>` — столбец, отсутствующий в payload, не трогается.
 * Если бы мы всегда передавали `username: profile.username ?? null`, то
 * update без username (Telegram не всегда его присылает) затёр бы уже
 * сохранённое значение null'ом. `phone` здесь никогда не устанавливается —
 * Telegram не передаёт его в обычных update, столбец заполняется только
 * будущими сценариями сбора контакта.
 */
export async function upsertTelegramUser(
  profile: TelegramUserProfile
): Promise<string> {
  const supabase = getServiceSupabaseClient();

  const payload: Record<string, string | null> = {
    telegram_user_id: profile.telegramUserId,
  };
  if (profile.username !== undefined) {
    payload.username = profile.username;
  }
  if (profile.firstName !== undefined) {
    payload.first_name = profile.firstName;
  }
  if (profile.lastName !== undefined) {
    payload.last_name = profile.lastName;
  }
  if (profile.languageCode !== undefined) {
    payload.language_code = profile.languageCode;
  }

  const { data, error } = await supabase
    .from("telegram_users")
    .upsert(payload, { onConflict: "telegram_user_id" })
    .select("id")
    .single<TelegramUserRow>();

  if (error || !data) {
    throw new Error(
      `Не удалось зарегистрировать Telegram-пользователя: ${error?.message ?? "пустой результат"}`,
      { cause: error }
    );
  }

  return data.id;
}
