import { describe, expect, it } from "vitest";
import { escapeTelegramHtml, formatReminderMessage } from "@/lib/reminders/message";

const START_AT = "2026-07-20T11:00:00.000Z"; // 14:00 в Europe/Moscow (+03:00)
const TIME_ZONE = "Europe/Moscow";

describe("escapeTelegramHtml", () => {
  it("экранирует &, < и > (порядок исключает двойное экранирование)", () => {
    expect(escapeTelegramHtml("Tom & Jerry")).toBe("Tom &amp; Jerry");
    expect(escapeTelegramHtml("<script>alert(1)</script>")).toBe(
      "&lt;script&gt;alert(1)&lt;/script&gt;"
    );
    expect(escapeTelegramHtml("A & <b>B</b>")).toBe("A &amp; &lt;b&gt;B&lt;/b&gt;");
  });

  it("не трогает обычный текст", () => {
    expect(escapeTelegramHtml("Мужская стрижка")).toBe("Мужская стрижка");
  });
});

describe("formatReminderMessage: 24h", () => {
  const message = formatReminderMessage({
    reminderType: "24h",
    serviceName: "Мужская стрижка",
    startAtIso: START_AT,
    timeZone: TIME_ZONE,
  });

  it("содержит заголовок и ключевые поля", () => {
    expect(message).toContain("⏰ Напоминание о записи");
    expect(message).toContain("Завтра у вас запись:");
    expect(message).toContain("Услуга: <b>Мужская стрижка</b>");
    expect(message).toContain("14:00");
    expect(message).toContain("До встречи!");
  });

  it("не утверждает конкретное число часов как гарантию (не '2h'-формулировка)", () => {
    expect(message).not.toContain("ровно через");
  });
});

describe("formatReminderMessage: 2h", () => {
  const message = formatReminderMessage({
    reminderType: "2h",
    serviceName: "Окрашивание корней",
    startAtIso: START_AT,
    timeZone: TIME_ZONE,
  });

  it("содержит заголовок и корректную формулировку про 'примерно'", () => {
    expect(message).toContain("⏰ Скоро ваша запись");
    expect(message).toContain("Запись начнётся примерно через 2 часа:");
    expect(message).toContain("Услуга: <b>Окрашивание корней</b>");
    expect(message).toContain("14:00");
    expect(message).toContain("До встречи!");
  });

  it("не утверждает 'ровно через 2 часа'", () => {
    expect(message).not.toMatch(/ровно/i);
  });
});

describe("formatReminderMessage: HTML-инъекция в названии услуги", () => {
  it("экранирует потенциально опасные символы в названии услуги", () => {
    const message = formatReminderMessage({
      reminderType: "24h",
      serviceName: "<b>Стрижка</b> & укладка",
      startAtIso: START_AT,
      timeZone: TIME_ZONE,
    });
    expect(message).toContain("Услуга: <b>&lt;b&gt;Стрижка&lt;/b&gt; &amp; укладка</b>");
    // Единственные настоящие HTML-теги в итоговом тексте — те, что мы сами
    // добавили вокруг названия услуги (<b>...</b>), не то, что было внутри
    // названия.
    expect(message.match(/<b>/g)?.length).toBe(1);
    expect(message.match(/<\/b>/g)?.length).toBe(1);
  });
});
