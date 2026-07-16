#!/usr/bin/env node
/**
 * Ручная регистрация списка команд бота в Telegram (меню "/" в клиенте).
 * Не выполняется автоматически — только по явному вызову
 * (npm run telegram:commands:set). Список команд должен совпадать с теми,
 * что реально зарегистрированы в lib/telegram/bot.ts.
 */
import { callTelegramApi, readRequiredEnv } from "./lib.mjs";

const COMMANDS = [
  { command: "start", description: "Начать работу с ботом" },
  { command: "book", description: "Записаться на приём" },
  { command: "mybookings", description: "Мои записи" },
  { command: "help", description: "Помощь" },
  { command: "cancel", description: "Отменить текущий незавершённый сценарий записи" },
];

async function main() {
  const token = readRequiredEnv("TELEGRAM_BOT_TOKEN");
  await callTelegramApi(token, "setMyCommands", { commands: COMMANDS });

  console.log("Список команд бота обновлён:");
  for (const { command, description } of COMMANDS) {
    console.log(`  /${command} — ${description}`);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
