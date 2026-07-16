import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Юнит-тесты диспетчеризации idempotency-middleware (lib/telegram/bot.ts:
 * createIdempotencyMiddleware) на фиктивных ctx/next — без поднятия
 * реального grammY Bot и без риска реального сетевого вызова Telegram API
 * (в отличие от прогона через полноценный createBot()/обработчики команд,
 * которые вызывают ctx.reply). Настоящую атомарность/lease на живом
 * PostgreSQL проверяют pgTAP-тесты и tests/integration/telegram-bot-flow.
 * test.ts — здесь только логика "что вызывается в каком порядке и с каким
 * claim_token в зависимости от результата claim".
 */

vi.mock("@/lib/telegram/idempotency", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/telegram/idempotency")>(
      "@/lib/telegram/idempotency"
    );
  return {
    ...actual,
    claimTelegramUpdate: vi.fn(),
    completeTelegramUpdate: vi.fn(),
    releaseTelegramUpdate: vi.fn(),
  };
});

import {
  BusyTelegramUpdateError,
  claimTelegramUpdate,
  completeTelegramUpdate,
  releaseTelegramUpdate,
} from "@/lib/telegram/idempotency";
import { createIdempotencyMiddleware } from "@/lib/telegram/bot";
import type { BotContext } from "@/lib/telegram/context";

function fakeCtx(updateId: number): BotContext {
  return { update: { update_id: updateId } } as BotContext;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("createIdempotencyMiddleware: claimed", () => {
  it("новый claim -> next() выполняется -> complete_telegram_update вызывается с этим claim_token", async () => {
    vi.mocked(claimTelegramUpdate).mockResolvedValue({
      status: "claimed",
      claimToken: "token-1",
    });
    vi.mocked(completeTelegramUpdate).mockResolvedValue(true);
    const next = vi.fn().mockResolvedValue(undefined);

    await createIdempotencyMiddleware()(fakeCtx(1), next);

    expect(claimTelegramUpdate).toHaveBeenCalledWith(1);
    expect(next).toHaveBeenCalledTimes(1);
    expect(completeTelegramUpdate).toHaveBeenCalledWith(1, "token-1");
    expect(releaseTelegramUpdate).not.toHaveBeenCalled();
  });

  it("complete_telegram_update вернул false (claim_token уже неактуален) -> не бросает, только логирует", async () => {
    vi.mocked(claimTelegramUpdate).mockResolvedValue({
      status: "claimed",
      claimToken: "token-stale",
    });
    vi.mocked(completeTelegramUpdate).mockResolvedValue(false);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const next = vi.fn().mockResolvedValue(undefined);

    await expect(
      createIdempotencyMiddleware()(fakeCtx(5), next)
    ).resolves.toBeUndefined();

    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("complete_telegram_update"),
      expect.objectContaining({ updateId: 5 })
    );
    errorSpy.mockRestore();
  });

  it("обычная ошибка в next() -> release_telegram_update вызывается с тем же claim_token, ошибка пробрасывается наружу", async () => {
    vi.mocked(claimTelegramUpdate).mockResolvedValue({
      status: "claimed",
      claimToken: "token-2",
    });
    vi.mocked(releaseTelegramUpdate).mockResolvedValue(true);
    const boom = new Error("business action failed");
    const next = vi.fn().mockRejectedValue(boom);

    await expect(
      createIdempotencyMiddleware()(fakeCtx(4), next)
    ).rejects.toBe(boom);

    expect(releaseTelegramUpdate).toHaveBeenCalledWith(
      4,
      "token-2",
      expect.any(String)
    );
    expect(completeTelegramUpdate).not.toHaveBeenCalled();
  });

  it("release_telegram_update тоже падает -> исходная ошибка всё равно пробрасывается (release не маскирует её)", async () => {
    vi.mocked(claimTelegramUpdate).mockResolvedValue({
      status: "claimed",
      claimToken: "token-3",
    });
    vi.mocked(releaseTelegramUpdate).mockRejectedValue(
      new Error("release RPC network error")
    );
    vi.spyOn(console, "error").mockImplementation(() => {});
    const boom = new Error("business action failed");
    const next = vi.fn().mockRejectedValue(boom);

    await expect(
      createIdempotencyMiddleware()(fakeCtx(6), next)
    ).rejects.toBe(boom);

    vi.restoreAllMocks();
  });
});

describe("createIdempotencyMiddleware: completed", () => {
  it("update уже обработан ранее -> next() НЕ выполняется, ничего не complete/release", async () => {
    vi.mocked(claimTelegramUpdate).mockResolvedValue({ status: "completed" });
    const next = vi.fn();

    await expect(
      createIdempotencyMiddleware()(fakeCtx(2), next)
    ).resolves.toBeUndefined();

    expect(next).not.toHaveBeenCalled();
    expect(completeTelegramUpdate).not.toHaveBeenCalled();
    expect(releaseTelegramUpdate).not.toHaveBeenCalled();
  });
});

describe("createIdempotencyMiddleware: busy", () => {
  it("другой воркер владеет ещё не истёкшим lease -> next() НЕ выполняется, бросает BusyTelegramUpdateError", async () => {
    vi.mocked(claimTelegramUpdate).mockResolvedValue({ status: "busy" });
    const next = vi.fn();

    let err: unknown;
    try {
      await createIdempotencyMiddleware()(fakeCtx(3), next);
    } catch (e) {
      err = e;
    }

    expect(err).toBeInstanceOf(BusyTelegramUpdateError);
    expect(next).not.toHaveBeenCalled();
    expect(completeTelegramUpdate).not.toHaveBeenCalled();
    expect(releaseTelegramUpdate).not.toHaveBeenCalled();
  });
});
