import { describe, expect, it } from "vitest";
import { parseEnv } from "@/lib/env";

const validEnv = {
  NEXT_PUBLIC_APP_URL: "http://localhost:3000",
  NEXT_PUBLIC_SUPABASE_URL: "https://example.supabase.co",
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_example",
  SUPABASE_SECRET_KEY: "sb_secret_example",
  TELEGRAM_BOT_TOKEN: "123:abc",
  TELEGRAM_BOT_USERNAME: "bookingbot_test_bot",
  TELEGRAM_WEBHOOK_SECRET: "webhook_secret-123",
  CRON_SECRET: "cron-secret",
};

describe("parseEnv", () => {
  it("возвращает данные, если все переменные заполнены корректно", () => {
    const env = parseEnv(validEnv);
    expect(env).toEqual(validEnv);
  });

  it("выбрасывает понятную ошибку при отсутствии секретного ключа", () => {
    const withoutSecret: Partial<typeof validEnv> = { ...validEnv };
    delete withoutSecret.SUPABASE_SECRET_KEY;

    expect(() => parseEnv(withoutSecret)).toThrowError(/SUPABASE_SECRET_KEY/);
  });

  it("выбрасывает понятную ошибку при отсутствии publishable-ключа", () => {
    const withoutPublishable: Partial<typeof validEnv> = { ...validEnv };
    delete withoutPublishable.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

    expect(() => parseEnv(withoutPublishable)).toThrowError(
      /NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY/
    );
  });

  it("больше не принимает устаревшие имена ключей как обязательные", () => {
    // Устаревшие NEXT_PUBLIC_SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY
    // не входят в схему: их наличие/отсутствие не влияет на валидацию.
    const legacyOnly = {
      ...validEnv,
    } as Record<string, string | undefined>;
    delete legacyOnly.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
    legacyOnly.NEXT_PUBLIC_SUPABASE_ANON_KEY = "legacy-anon";

    // Отсутствует современный publishable-ключ → ошибка именно про него,
    // а не молчаливое принятие устаревшего имени.
    expect(() => parseEnv(legacyOnly)).toThrowError(
      /NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY/
    );
  });

  it("выбрасывает ошибку при некорректном URL", () => {
    expect(() =>
      parseEnv({ ...validEnv, NEXT_PUBLIC_SUPABASE_URL: "not-a-url" })
    ).toThrowError(/NEXT_PUBLIC_SUPABASE_URL/);
  });

  it("не содержит BUSINESS_TIMEZONE — эта переменная не используется архитектурой", () => {
    // Этап 2 уже сделал business_settings.timezone (столбец в БД)
    // источником истины для всех SQL-функций бронирования; seed.sql
    // тоже хранит часовой пояс прямо в строке, а не читает env. К началу
    // Этапа 3 BUSINESS_TIMEZONE нигде в коде не использовался (см. git
    // history) — это была мёртвая переменная. Бот (lib/telegram/formatters.ts)
    // читает часовой пояс из той же таблицы business_settings, а не из env,
    // чтобы не было двух источников истины. Поэтому переменная удалена из
    // схемы целиком, а не просто ослаблена.
    const env = parseEnv(validEnv);
    expect(env).not.toHaveProperty("BUSINESS_TIMEZONE");
  });

  it.each(["webhook_secret-123", "A", "1".repeat(256), "abc_ABC-123"])(
    "принимает корректный TELEGRAM_WEBHOOK_SECRET %s",
    (secret) => {
      const env = parseEnv({ ...validEnv, TELEGRAM_WEBHOOK_SECRET: secret });
      expect(env.TELEGRAM_WEBHOOK_SECRET).toBe(secret);
    }
  );

  it.each([
    "", // пустая строка
    "1".repeat(257), // длиннее 256 символов
    "secret with spaces",
    "secret:with:colons",
    "секрет-кириллица",
    "secret.with.dots",
    "secret+plus",
  ])("отклоняет некорректный TELEGRAM_WEBHOOK_SECRET %j", (secret) => {
    expect(() =>
      parseEnv({ ...validEnv, TELEGRAM_WEBHOOK_SECRET: secret })
    ).toThrowError(/TELEGRAM_WEBHOOK_SECRET/);
  });
});
