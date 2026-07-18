import type { Page } from "@playwright/test";
import { getE2eEnv } from "./env";

export async function loginAs(page: Page, email: string, password: string): Promise<void> {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Пароль").fill(password);
  await page.getByRole("button", { name: "Войти" }).click();
}

export async function loginAsAdmin(page: Page): Promise<void> {
  const env = getE2eEnv();
  if (!env) {
    throw new Error("getE2eEnv() вернул null — вызывающий тест должен был себя пропустить раньше");
  }
  await loginAs(page, env.adminEmail, env.adminPassword);
  await page.waitForURL("/admin");
}
