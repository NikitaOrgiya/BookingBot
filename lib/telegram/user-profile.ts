import type { User } from "grammy/types";
import type { TelegramUserProfile } from "./repositories/telegram-users";

/**
 * Извлекает профиль клиента из объекта Telegram `User` (message.from или
 * callback_query.from).
 *
 * Telegram Bot API кодирует `user.id` как JSON-число, и к моменту, когда
 * grammY передаёт нам `ctx.from`, `JSON.parse()` уже отработал — если
 * реальный Telegram id когда-либо превысит Number.MAX_SAFE_INTEGER,
 * точность уже будет потеряна на этом шаге, и никакой код на нашей
 * стороне не может это исправить (ограничение любой Bot API библиотеки,
 * работающей поверх JSON, а не только grammY). Наша ответственность —
 * не усугублять ситуацию: конвертируем в строку немедленно, здесь и
 * только здесь, и дальше нигде не применяем Number()/parseInt()/
 * арифметику к этой строке (см. lib/booking/schemas.ts — тот же принцип
 * для RPC-параметров бронирования).
 *
 * Поля username/first_name/last_name/language_code передаются как
 * `undefined`, если Telegram не включил их в конкретный update — это
 * позволяет upsertTelegramUser не затирать ранее сохранённые значения
 * (см. репозиторий).
 */
export function extractTelegramUserProfile(
  user: User
): TelegramUserProfile {
  return {
    telegramUserId: String(user.id),
    username: user.username,
    firstName: user.first_name,
    lastName: user.last_name,
    languageCode: user.language_code,
  };
}
