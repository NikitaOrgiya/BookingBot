import { expect, test } from "@playwright/test";
import { getE2eEnv } from "./env";
import { loginAsAdmin } from "./helpers";

const env = getE2eEnv();
const serviceName = `E2E услуга ${Date.now()}`;

test.describe("управление услугами", () => {
  test.skip(!env, "локальный Supabase-стек не настроен (см. tests/e2e/README.md)");

  test.beforeEach(async ({ page }) => {
    await loginAsAdmin(page);
    await page.goto("/admin/services");
  });

  test("6. создаётся новая услуга", async ({ page }) => {
    await page.getByText("Добавить услугу").click();
    await page.getByLabel("Название").fill(serviceName);
    await page.getByLabel("Длительность (мин)").fill("45");
    await page.getByLabel("Цена (₽)").fill("1500");
    await page.getByRole("button", { name: "Создать услугу" }).click();

    await expect(page.getByText("Услуга создана.")).toBeVisible();
    await page.reload();
    await expect(page.getByText(serviceName)).toBeVisible();
  });

  test("7. услуга изменяется и деактивируется", async ({ page }) => {
    const row = page.locator("li", { hasText: serviceName });
    await row.getByText("Изменить").click();
    await row.getByLabel("Цена (₽)").fill("1800");
    await row.getByRole("button", { name: "Сохранить изменения" }).click();
    await expect(row.getByText("Услуга обновлена.")).toBeVisible();

    page.once("dialog", (dialog) => dialog.accept());
    await row.getByRole("button", { name: "Деактивировать" }).click();
    await expect(row.getByText("Неактивна")).toBeVisible();

    // Кнопки физического удаления в интерфейсе нет и быть не должно.
    await expect(row.getByRole("button", { name: "Удалить" })).toHaveCount(0);
  });
});
