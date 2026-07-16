import { describe, expect, it } from "vitest";
import { parseEnv } from "@/lib/env";

const validEnv = {
  NEXT_PUBLIC_APP_URL: "http://localhost:3000",
  NEXT_PUBLIC_SUPABASE_URL: "https://example.supabase.co",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon-key",
  SUPABASE_SERVICE_ROLE_KEY: "service-role-key",
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

  it("выбрасывает понятную ошибку при отсутствии обязательной переменной", () => {
    const withoutServiceRole: Partial<typeof validEnv> = { ...validEnv };
    delete withoutServiceRole.SUPABASE_SERVICE_ROLE_KEY;

    expect(() => parseEnv(withoutServiceRole)).toThrowError(
      /SUPABASE_SERVICE_ROLE_KEY/
    );
  });

  it("выбрасывает ошибку при некорректном URL", () => {
    expect(() =>
      parseEnv({ ...validEnv, NEXT_PUBLIC_SUPABASE_URL: "not-a-url" })
    ).toThrowError(/NEXT_PUBLIC_SUPABASE_URL/);
  });
});
