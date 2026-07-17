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
    // Каждая существующая услуга тоже рендерит свою (свёрнутую) форму
    // редактирования с полем "Название" (см. app/admin/services/page.tsx),
    // поэтому page.getByLabel("Название") без учёта контекста совпадёт со
    // всеми ними разом (strict mode violation) — нужно явно взять форму
    // именно создания, по кнопке "Создать услугу", которая есть только в
    // ней (у форм редактирования — "Сохранить изменения").
    await page.getByText("Добавить услугу").click();
    const createForm = page
      .locator("form")
      .filter({ has: page.getByRole("button", { name: "Создать услугу" }) });
    await createForm.getByLabel("Название").fill(serviceName);
    await createForm.getByLabel("Длительность (мин)").fill("45");
    await createForm.getByLabel("Цена (₽)").fill("1500");
    await createForm.getByRole("button", { name: "Создать услугу" }).click();

    await expect(createForm.getByText("Услуга создана.")).toBeVisible();
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
