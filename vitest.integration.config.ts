import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/integration/**/*.test.ts"],
    // Тест конкурентной гонки открывает реальные TCP-соединения к
    // PostgreSQL и ждёт ответа сервера — оставляем щедрый таймаут вместо
    // дефолтных 5с.
    testTimeout: 20000,
  },
});
