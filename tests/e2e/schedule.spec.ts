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
    // Раньше карточка бралась через getByRole("heading", {name:"Пн"}).locator("..")
    // — подъём к родителю через ".." хрупок к структуре разметки (любая
    // обёртка вокруг заголовка тихо ломает локатор без явной ошибки) и не
    // виден в отчёте как относящийся к конкретному дню. Карточка каждого дня
    // теперь несёт стабильный data-testid (app/admin/schedule/page.tsx),
    // не зависящий ни от локализованного текста, ни от порядка/вложенности
    // элементов внутри неё.
    const mondayCard = page.getByTestId("working-hours-day-0");
    await expect(mondayCard).toBeVisible();
    await expect(mondayCard.getByRole("button", { name: "Добавить интервал" })).toBeVisible();

    // seed.sql намеренно не создаёт working_hours ни для одного дня (см.
    // комментарий в файле) — на только что применённой миграциями+seed базе
    // понедельник гарантированно пуст, поэтому новый интервал не может
    // пересечься с уже существующим и не зависит от production-расписания.
    await mondayCard.locator('input[name="startTime"]').fill("09:00");
    await mondayCard.locator('input[name="endTime"]').fill("13:00");
    await mondayCard.getByRole("button", { name: "Добавить интервал" }).click();

    // Проверяем реально сохранённое состояние (интервал в списке карточки
    // после router.refresh()), а не промежуточный/исчезающий toast.
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
