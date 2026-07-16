import { describe, expect, it } from "vitest";
import { parseEnv } from "@/lib/env";

const validEnv = {
  NEXT_PUBLIC_APP_URL: "http://localhost:3000",
  NEXT_PUBLIC_SUPABASE_URL: "https://example.supabase.co",
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_example",
  SUPABASE_SECRET_KEY: "sb_secret_example",
  TELEGRAM_BOT_TOKEN: "123:abc",
  TELEGRAM_BOT_USERNAME: "bookingbot_test_bot",
  TELEGRAM_WEBHOOK_SECRET: "webhook-secret",
  CRON_SECRET: "cron-secret",
  BUSINESS_TIMEZONE: "Europe/Moscow",
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

  it.each(["Europe/Moscow", "Europe/London", "Asia/Almaty", "America/New_York"])(
    "принимает настоящий IANA часовой пояс %s",
    (timezone) => {
      const env = parseEnv({ ...validEnv, BUSINESS_TIMEZONE: timezone });
      expect(env.BUSINESS_TIMEZONE).toBe(timezone);
    }
  );

  it.each([
    "Europe/Moskow", // опечатка
    "UTC+3", // смещение, а не IANA-идентификатор
    "Moscow", // город без региона
    "GMT+3",
    "not/a-timezone",
    "",
  ])("отклоняет некорректный часовой пояс %s", (timezone) => {
    expect(() =>
      parseEnv({ ...validEnv, BUSINESS_TIMEZONE: timezone })
    ).toThrowError(/BUSINESS_TIMEZONE/);
  });
});
