import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Проверяет границу "server-only" привилегированного Supabase-клиента.
 *
 * В клиентском (браузерном) бандле пакет "server-only" резолвится в модуль,
 * который бросает ошибку при импорте (см. node_modules/server-only/index.js).
 * Здесь мы имитируем клиентский бандл, подменяя "server-only" бросающим
 * мок-модулем, и убеждаемся, что импорт серверного клиента (а значит и
 * secret-ключ) при этом невозможен, тогда как публичный клиент и чистые
 * доменные ошибки импортируются как ни в чём не бывало. Именно этот контраст
 * доказывает, что secret-ключ заперт за границей server-only.
 *
 * В обычном прогоне vitest настроен на условие "react-server", поэтому
 * "server-only" безвреден — именно поэтому для проверки границы нужен мок.
 */

afterEach(() => {
  vi.resetModules();
  vi.doUnmock("server-only");
});

describe("server-only граница", () => {
  it("серверный клиент нельзя импортировать в клиентском бандле", async () => {
    vi.resetModules();
    vi.doMock("server-only", () => {
      throw new Error(
        "This module cannot be imported from a Client Component module."
      );
    });

    // Импорт обязан упасть: серверный клиент тянет "server-only", который в
    // клиентском бандле бросает ошибку. Сообщение исходит от слоя мока
    // vitest, поэтому проверяем сам факт отклонения, а не текст.
    await expect(
      import("@/lib/supabase/server-client")
    ).rejects.toBeInstanceOf(Error);
  });

  it("публичный клиент НЕ тянет server-only и импортируется в клиентском бандле", async () => {
    vi.resetModules();
    vi.doMock("server-only", () => {
      throw new Error(
        "This module cannot be imported from a Client Component module."
      );
    });

    // Публичный клиент использует только publishable-ключ и не зависит от
    // server-only — импорт должен пройти даже при "клиентском" server-only.
    await expect(
      import("@/lib/supabase/public-client")
    ).resolves.toHaveProperty("getPublicSupabaseClient");
  });

  it("доменные ошибки и типы (errors.ts) client-safe — импортируются без server-only", async () => {
    vi.resetModules();
    vi.doMock("server-only", () => {
      throw new Error(
        "This module cannot be imported from a Client Component module."
      );
    });

    await expect(import("@/lib/booking/errors")).resolves.toHaveProperty(
      "BOOKING_ERROR_CODES"
    );
  });
});
