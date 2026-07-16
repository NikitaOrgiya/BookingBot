/**
 * Общие хелперы для служебных скриптов управления Telegram-ботом
 * (scripts/telegram/webhook.mjs, scripts/telegram/commands.mjs).
 *
 * Эти скрипты — отдельные ручные CLI-утилиты, не часть приложения Next.js,
 * поэтому они НЕ импортируют lib/env.ts или что-либо из lib/telegram/*:
 * эти модули начинаются с `import "server-only"`, а пакет server-only вне
 * сборки Next.js (без её react-server export condition) безусловно бросает
 * исключение при импорте — см. node_modules/server-only/index.js. Здесь
 * своя минимальная независимая проверка нужных переменных окружения.
 *
 * Ни при каких обстоятельствах эти скрипты не должны печатать значение
 * TELEGRAM_BOT_TOKEN или TELEGRAM_WEBHOOK_SECRET — только факт их наличия
 * и результат операций.
 */

export function readRequiredEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Переменная окружения ${name} обязательна (см. .env.example). ` +
        `Запустите скрипт как: npm run <script> (использует --env-file=.env.local).`
    );
  }
  return value;
}

/** Убирает токен из произвольного текста (сообщения об ошибке сети/fetch
 * иногда включают запрошенный URL целиком, а URL Telegram Bot API содержит
 * токен). */
export function redactToken(text, token) {
  if (!token) {
    return text;
  }
  return text.split(token).join("***");
}

/**
 * Вызывает метод Telegram Bot API. Бросает исключение с безопасным (без
 * токена) текстом при сетевой ошибке или при ok !== true в ответе.
 */
export async function callTelegramApi(token, method, body) {
  const url = `https://api.telegram.org/bot${token}/${method}`;

  let response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Запрос к Telegram Bot API (${method}) не удался: ${redactToken(message, token)}`
    );
  }

  const json = await response.json().catch(() => null);
  if (!response.ok || !json || json.ok !== true) {
    const description =
      json && typeof json.description === "string"
        ? json.description
        : `HTTP ${response.status}`;
    throw new Error(
      `Telegram Bot API вернул ошибку (${method}): ${redactToken(description, token)}`
    );
  }

  return json.result;
}
