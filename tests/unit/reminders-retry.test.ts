import { GrammyError, HttpError } from "grammy";
import { describe, expect, it } from "vitest";
import {
  classifyTelegramError,
  computeNextAttemptDelaySeconds,
  extractSafeErrorCode,
  extractSafeErrorMessage,
  isTerminalAttempt,
  MAX_REMINDER_ATTEMPTS,
} from "@/lib/reminders/retry";

function grammyError(errorCode: number, description = "some error", retryAfter?: number): GrammyError {
  return new GrammyError(
    "Call to sendMessage failed",
    {
      ok: false,
      error_code: errorCode,
      description,
      parameters: retryAfter !== undefined ? { retry_after: retryAfter } : undefined,
    },
    "sendMessage",
    {}
  );
}

describe("isTerminalAttempt", () => {
  it("не финальна, пока попыток меньше MAX_REMINDER_ATTEMPTS", () => {
    for (let n = 1; n < MAX_REMINDER_ATTEMPTS; n += 1) {
      expect(isTerminalAttempt(n)).toBe(false);
    }
  });

  it("финальна ровно на MAX_REMINDER_ATTEMPTS и позже", () => {
    expect(isTerminalAttempt(MAX_REMINDER_ATTEMPTS)).toBe(true);
    expect(isTerminalAttempt(MAX_REMINDER_ATTEMPTS + 1)).toBe(true);
  });
});

describe("computeNextAttemptDelaySeconds: расписание 1мин/5мин/15мин/1час", () => {
  it("возвращает 60/300/900/3600 для попыток 1-4", () => {
    expect(computeNextAttemptDelaySeconds(1)).toBe(60);
    expect(computeNextAttemptDelaySeconds(2)).toBe(300);
    expect(computeNextAttemptDelaySeconds(3)).toBe(900);
    expect(computeNextAttemptDelaySeconds(4)).toBe(3600);
  });

  it("не выходит за пределы расписания для попытки 5 и выше", () => {
    expect(computeNextAttemptDelaySeconds(5)).toBe(3600);
    expect(computeNextAttemptDelaySeconds(99)).toBe(3600);
  });

  it("Telegram retry_after (429) имеет приоритет над стандартным расписанием", () => {
    expect(computeNextAttemptDelaySeconds(1, 15)).toBe(15);
    expect(computeNextAttemptDelaySeconds(2, 45)).toBe(45);
  });

  it("аномально большой retry_after ограничивается сверху", () => {
    expect(computeNextAttemptDelaySeconds(1, 999999)).toBeLessThanOrEqual(3600);
  });

  it("retry_after = 0 или отрицательный игнорируется в пользу расписания", () => {
    expect(computeNextAttemptDelaySeconds(1, 0)).toBe(60);
  });
});

describe("classifyTelegramError", () => {
  it("429 Too Many Requests -> retryable с retry_after", () => {
    const result = classifyTelegramError(grammyError(429, "Too Many Requests", 30));
    expect(result.retryable).toBe(true);
    expect(result.retryAfterSeconds).toBe(30);
  });

  it("5xx -> retryable без retry_after", () => {
    const result = classifyTelegramError(grammyError(500, "Internal Server Error"));
    expect(result.retryable).toBe(true);
    expect(result.retryAfterSeconds).toBeUndefined();
  });

  it("400/403/404 -> НЕ retryable (постоянные ошибки)", () => {
    expect(classifyTelegramError(grammyError(400, "Bad Request: chat not found")).retryable).toBe(false);
    expect(classifyTelegramError(grammyError(403, "Forbidden: bot was blocked by the user")).retryable).toBe(false);
    expect(classifyTelegramError(grammyError(404, "Not Found")).retryable).toBe(false);
  });

  it("прочие GrammyError коды по умолчанию retryable", () => {
    expect(classifyTelegramError(grammyError(409, "Conflict")).retryable).toBe(true);
  });

  it("HttpError (сетевая ошибка) -> retryable", () => {
    const error = new HttpError("network failed", new Error("ECONNRESET"));
    expect(classifyTelegramError(error).retryable).toBe(true);
  });

  it("неизвестная ошибка -> retryable (ограничено MAX_REMINDER_ATTEMPTS в вызывающем коде)", () => {
    expect(classifyTelegramError(new Error("что-то пошло не так")).retryable).toBe(true);
    expect(classifyTelegramError("строка вместо ошибки").retryable).toBe(true);
  });
});

describe("extractSafeErrorCode", () => {
  it("GrammyError -> TELEGRAM_<code>", () => {
    expect(extractSafeErrorCode(grammyError(403))).toBe("TELEGRAM_403");
  });

  it("HttpError -> TELEGRAM_NETWORK_ERROR", () => {
    expect(extractSafeErrorCode(new HttpError("x", new Error("y")))).toBe(
      "TELEGRAM_NETWORK_ERROR"
    );
  });

  it("прочее -> INTERNAL_ERROR", () => {
    expect(extractSafeErrorCode(new Error("x"))).toBe("INTERNAL_ERROR");
    expect(extractSafeErrorCode("x")).toBe("INTERNAL_ERROR");
  });
});

describe("extractSafeErrorMessage: без токена/URL/PII", () => {
  it("GrammyError -> человекочитаемое описание Telegram", () => {
    const message = extractSafeErrorMessage(
      grammyError(403, "Forbidden: bot was blocked by the user")
    );
    expect(message).toContain("Forbidden: bot was blocked by the user");
    expect(message).toContain("403");
  });

  it("HttpError НИКОГДА не включает message исходной сетевой ошибки (может содержать URL с токеном)", () => {
    const secretLookingUrl = "https://api.telegram.org/bot123456:AAFakeTokenValue/sendMessage";
    const httpError = new HttpError("request failed", new Error(secretLookingUrl));
    const message = extractSafeErrorMessage(httpError);
    expect(message).not.toContain(secretLookingUrl);
    expect(message).not.toContain("123456:AAFakeTokenValue");
  });

  it("неизвестная ошибка -> общий безопасный текст, не message исходной ошибки", () => {
    const message = extractSafeErrorMessage(
      new Error("connect ECONNREFUSED 127.0.0.1:5432 — pg_hba.conf rejects connection")
    );
    expect(message).not.toContain("pg_hba.conf");
    expect(message).not.toContain("127.0.0.1");
  });

  it("обрезает длинные сообщения до разумной длины", () => {
    const longDescription = "x".repeat(2000);
    const message = extractSafeErrorMessage(grammyError(400, longDescription));
    expect(message.length).toBeLessThanOrEqual(500);
  });
});
