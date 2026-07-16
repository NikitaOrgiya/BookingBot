#!/usr/bin/env node
/**
 * Ручное управление Telegram webhook: info | set | delete.
 *
 * Не выполняется автоматически ни при dev/build/test/deploy — только по
 * явному вызову (npm run telegram:webhook:info|set|delete). Требует
 * .env.local с уже реальными TELEGRAM_BOT_TOKEN/NEXT_PUBLIC_APP_URL/
 * TELEGRAM_WEBHOOK_SECRET и HTTPS-доступный NEXT_PUBLIC_APP_URL — то есть
 * его нет смысла (и не следует) запускать до реального деплоя.
 *
 * Использует только необходимые allowed_updates (message, callback_query):
 * бот не читает inline-режим, реакции, платежи и т.д., и не должен
 * получать эти update'ы от Telegram вообще.
 *
 * "delete" по умолчанию НЕ сбрасывает накопленные обновления
 * (drop_pending_updates: false) — это осознанный выбор владельца бота,
 * поэтому сброс требует явного флага --drop-pending-updates.
 */
import { callTelegramApi, readRequiredEnv } from "./lib.mjs";

const ALLOWED_UPDATES = ["message", "callback_query"];
const WEBHOOK_SECRET_PATTERN = /^[A-Za-z0-9_-]{1,256}$/;

async function commandInfo(token) {
  const info = await callTelegramApi(token, "getWebhookInfo");
  console.log("Текущая конфигурация Telegram webhook:");
  console.log(`  url: ${info.url || "(не установлен)"}`);
  console.log(`  has_custom_certificate: ${Boolean(info.has_custom_certificate)}`);
  console.log(`  pending_update_count: ${info.pending_update_count ?? 0}`);
  console.log(
    `  allowed_updates: ${
      Array.isArray(info.allowed_updates) && info.allowed_updates.length > 0
        ? info.allowed_updates.join(", ")
        : "(не ограничено — все типы по умолчанию)"
    }`
  );
  if (info.last_error_message) {
    const when = info.last_error_date
      ? new Date(info.last_error_date * 1000).toISOString()
      : "неизвестно";
    console.log(`  last_error_date: ${when}`);
    console.log(`  last_error_message: ${info.last_error_message}`);
  }
}

async function commandSet(token) {
  const appUrl = readRequiredEnv("NEXT_PUBLIC_APP_URL");
  const secret = readRequiredEnv("TELEGRAM_WEBHOOK_SECRET");

  if (!WEBHOOK_SECRET_PATTERN.test(secret)) {
    throw new Error(
      "TELEGRAM_WEBHOOK_SECRET не соответствует ограничениям Telegram Bot API " +
        "(1-256 символов, только A-Z, a-z, 0-9, '_' и '-')."
    );
  }

  const url = new URL("/api/telegram/webhook", appUrl);
  if (url.protocol !== "https:") {
    throw new Error(
      `NEXT_PUBLIC_APP_URL должен быть https:// для регистрации Telegram webhook (получено: ${url.protocol})`
    );
  }

  await callTelegramApi(token, "setWebhook", {
    url: url.toString(),
    secret_token: secret,
    allowed_updates: ALLOWED_UPDATES,
  });

  console.log(`Webhook установлен: ${url.toString()}`);
  console.log(`allowed_updates: ${ALLOWED_UPDATES.join(", ")}`);
  console.log("secret_token: установлен (значение не выводится)");
}

async function commandDelete(token) {
  const dropPendingUpdates = process.argv.includes("--drop-pending-updates");
  await callTelegramApi(token, "deleteWebhook", {
    drop_pending_updates: dropPendingUpdates,
  });
  console.log(
    dropPendingUpdates
      ? "Webhook удалён, накопленные обновления сброшены (--drop-pending-updates)."
      : "Webhook удалён. Накопленные обновления сохранены (используйте --drop-pending-updates, чтобы явно их сбросить)."
  );
}

function printUsage() {
  console.error(
    "Использование: node scripts/telegram/webhook.mjs <info|set|delete> [--drop-pending-updates]"
  );
}

async function main() {
  const subcommand = process.argv[2];
  const token = readRequiredEnv("TELEGRAM_BOT_TOKEN");

  switch (subcommand) {
    case "info":
      await commandInfo(token);
      return;
    case "set":
      await commandSet(token);
      return;
    case "delete":
      await commandDelete(token);
      return;
    default:
      printUsage();
      process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
