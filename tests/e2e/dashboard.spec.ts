import { expect, test } from "@playwright/test";
import { getE2eEnv } from "./env";
import { loginAsAdmin } from "./helpers";

const env = getE2eEnv();

test.describe("dashboard", () => {
  test.skip(!env, "локальный Supabase-стек не настроен (см. tests/e2e/README.md)");

  test("5. dashboard открывается и показывает счётчики и быстрые ссылки", async ({ page }) => {
    await loginAsAdmin(page);

    await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();
    await expect(page.getByText("Подтверждённые записи сегодня")).toBeVisible();
    await expect(page.getByText("Записей на этой неделе")).toBeVisible();
    await expect(page.getByText("Отменено на этой неделе")).toBeVisible();
    await expect(page.getByRole("link", { name: "Управление услугами" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Управление расписанием" })).toBeVisible();
  });
});
