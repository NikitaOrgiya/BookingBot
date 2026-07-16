import { describe, expect, it } from "vitest";
import type { User } from "grammy/types";
import { extractTelegramUserProfile } from "@/lib/telegram/user-profile";

function makeUser(overrides: Partial<User> = {}): User {
  return {
    id: 123456789,
    is_bot: false,
    first_name: "Иван",
    ...overrides,
  };
}

describe("extractTelegramUserProfile", () => {
  it("немедленно конвертирует user.id в строку", () => {
    const profile = extractTelegramUserProfile(makeUser({ id: 42 }));
    expect(profile.telegramUserId).toBe("42");
    expect(typeof profile.telegramUserId).toBe("string");
  });

  it("сохраняет значение id как строку без потери точности у больших чисел", () => {
    // Число за пределами Number.MAX_SAFE_INTEGER — точность уже потеряна на
    // этапе JSON.parse (ограничение любой Bot API библиотеки), но здесь
    // проверяем, что мы хотя бы не усугубляем это дальнейшей арифметикой:
    // String(user.id) должен совпасть с обычным приведением к строке.
    const bigId = 9007199254740993; // MAX_SAFE_INTEGER + 2
    const profile = extractTelegramUserProfile(makeUser({ id: bigId }));
    expect(profile.telegramUserId).toBe(String(bigId));
  });

  it("передаёт username/first_name/last_name/language_code как undefined, если Telegram их не прислал", () => {
    const profile = extractTelegramUserProfile(
      makeUser({ username: undefined, last_name: undefined, language_code: undefined })
    );
    expect(profile.username).toBeUndefined();
    expect(profile.lastName).toBeUndefined();
    expect(profile.languageCode).toBeUndefined();
  });

  it("передаёт все поля, когда они присутствуют в update", () => {
    const profile = extractTelegramUserProfile(
      makeUser({
        username: "ivan_ivanov",
        first_name: "Иван",
        last_name: "Иванов",
        language_code: "ru",
      })
    );
    expect(profile).toEqual({
      telegramUserId: "123456789",
      username: "ivan_ivanov",
      firstName: "Иван",
      lastName: "Иванов",
      languageCode: "ru",
    });
  });
});
