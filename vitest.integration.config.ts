import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "."),
    },
    // Как в vitest.config.ts: без этого условия пакет "server-only",
    // который тянут некоторые модули lib/booking и lib/supabase, бросает
    // ошибку даже в легитимном серверном коде, который здесь тестируется.
    conditions: ["react-server"],
  },
  ssr: {
    resolve: {
      conditions: ["react-server"],
    },
  },
  test: {
    environment: "node",
    include: ["tests/integration/**/*.test.ts"],
    // Тест конкурентной гонки открывает реальные TCP-соединения к
    // PostgreSQL и ждёт ответа сервера — оставляем щедрый таймаут вместо
    // дефолтных 5с.
    testTimeout: 20000,
    // Несколько файлов интеграционных тестов временно меняют одну и ту же
    // singleton-строку business_settings (id = 1) в общей тестовой базе и
    // восстанавливают её в afterAll. При параллельном запуске файлов (это
    // поведение vitest по умолчанию) один файл может прочитать/перезаписать
    // это значение в момент, когда другой файл его тоже меняет — ложные
    // OUTSIDE_BOOKING_HORIZON и подобные гонки, не имеющие отношения к
    // тестируемому коду. Файлы интеграционных тестов запускаются строго
    // последовательно, поэтому такой гонки между ними не возникает.
    fileParallelism: false,
  },
});
