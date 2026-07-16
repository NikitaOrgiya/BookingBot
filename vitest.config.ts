import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "."),
    },
    // Совпадает с условием, которое Next.js использует при компиляции
    // серверных модулей — без него пакет "server-only" всегда бросает
    // ошибку, даже в легитимном серверном коде, который мы тестируем.
    conditions: ["react-server"],
  },
  ssr: {
    resolve: {
      conditions: ["react-server"],
    },
  },
  test: {
    environment: "node",
    include: ["tests/unit/**/*.test.ts"],
  },
});
