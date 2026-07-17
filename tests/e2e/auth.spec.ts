import { expect, test } from "@playwright/test";
import { getE2eEnv } from "./env";
import { loginAs, loginAsAdmin } from "./helpers";

const env = getE2eEnv();

test.describe("аутентификация панели администратора", () => {
  test.skip(!env, "локальный Supabase-стек не настроен (см. tests/e2e/README.md)");

  test("1. неавторизованный /admin направляет на /login", async ({ page }) => {
    await page.goto("/admin");
    await expect(page).toHaveURL(/\/login/);
    await expect(page.getByRole("heading", { name: "Вход в панель администратора" })).toBeVisible();
  });

  test("2. неверный пароль показывает безопасную ошибку (не раскрывает существование email)", async ({
    page,
  }) => {
    await loginAs(page, env!.adminEmail, "определённо-неверный-пароль");
    await expect(page).toHaveURL(/\/login/);
    await expect(page.getByRole("alert")).toHaveText("Неверный email или пароль.");
  });

  test("3. неадминистратор не получает доступ к панели", async ({ page }) => {
    await loginAs(page, env!.nonAdminEmail, env!.nonAdminPassword);
    await expect(page).toHaveURL(/\/login/);
    await expect(page.getByRole("alert")).toHaveText(
      "У этой учётной записи нет доступа к панели администратора."
    );
  });

  test("4. администратор входит и попадает на dashboard", async ({ page }) => {
    await loginAsAdmin(page);
    await expect(page).toHaveURL(/\/admin$/);
    await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();
  });

  test("12. администратор выходит из панели", async ({ page }) => {
    await loginAsAdmin(page);
    await page.getByRole("button", { name: "Выход" }).first().click();
    await expect(page).toHaveURL(/\/login/);

    // Сессия действительно завершена: повторный заход на /admin снова
    // требует входа, а не отдаёт закешированную страницу.
    await page.goto("/admin");
    await expect(page).toHaveURL(/\/login/);
  });
});
