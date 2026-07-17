import { expect, test } from "@playwright/test";
import { getE2eEnv } from "./env";
import { loginAsAdmin } from "./helpers";

const env = getE2eEnv();

test.describe("расписание", () => {
  test.skip(!env, "локальный Supabase-стек не настроен (см. tests/e2e/README.md)");

  test.beforeEach(async ({ page }) => {
    await loginAsAdmin(page);
    await page.goto("/admin/schedule");
  });

  test("8. добавляется рабочий интервал", async ({ page }) => {
    // Каждая карточка дня недели также содержит <select> с опциями всех 7
    // дней (WorkingHourForm), поэтому фильтр по тексту "Пн" на div совпал
    // бы со всеми 7 карточками — вместо этого берём заголовок с точным
    // текстом "Пн" и поднимаемся к его родителю (карточка конкретного дня).
    const mondayCard = page.getByRole("heading", { name: "Пн", exact: true }).locator("..");
    const timeInputs = mondayCard.locator('input[type="time"]');
    await timeInputs.nth(0).fill("09:00");
    await timeInputs.nth(1).fill("13:00");
    await mondayCard.getByRole("button", { name: "Добавить интервал" }).click();

    await expect(mondayCard.getByText("09:00–13:00")).toBeVisible();
  });

  test("9. создаётся разовая блокировка", async ({ page }) => {
    const futureDate = new Date();
    futureDate.setDate(futureDate.getDate() + 60);
    const dateString = futureDate.toISOString().slice(0, 10);

    const createForm = page.locator("form", { has: page.locator('input[name="localDate"]') }).first();
    await createForm.locator('input[name="localDate"]').fill(dateString);
    await createForm.locator('input[name="startTime"]').fill("00:00");
    await createForm.locator('input[name="endTime"]').fill("23:59");
    await createForm.locator('input[name="reason"]').fill("E2E: выходной день");
    await createForm.getByRole("button", { name: "Создать блокировку" }).click();

    await expect(page.getByText("Блокировка создана.")).toBeVisible();
    await page.reload();
    await expect(page.getByText("E2E: выходной день")).toBeVisible();
  });
});
