import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { expect, test } from "@playwright/test";
import { getE2eEnv } from "./env";
import { loginAsAdmin } from "./helpers";

const env = getE2eEnv();

test.describe("управление записями", () => {
  test.skip(!env, "локальный Supabase-стек не настроен (см. tests/e2e/README.md)");

  const serviceId = randomUUID();
  const telegramUserRowId = randomUUID();
  const telegramUserId = `${Date.now()}`;
  const appointmentId = randomUUID();
  const clientFirstName = `E2EClient${Date.now()}`;

  test.beforeAll(async () => {
    if (!env) return;
    const pg = new Client({ connectionString: env.databaseUrl });
    await pg.connect();
    try {
      await pg.query(
        `insert into public.services (id, name, duration_minutes, price_cents, is_active)
         values ($1, 'E2E: услуга для записи', 30, 100000, true)`,
        [serviceId]
      );
      await pg.query(
        `insert into public.telegram_users (id, telegram_user_id, first_name)
         values ($1, $2, $3)`,
        [telegramUserRowId, telegramUserId, clientFirstName]
      );
      const startAt = new Date();
      startAt.setDate(startAt.getDate() + 45);
      startAt.setHours(12, 0, 0, 0);
      const endAt = new Date(startAt.getTime() + 30 * 60_000);
      await pg.query(
        `insert into public.appointments (
           id, telegram_user_id, service_id, service_name_snapshot,
           duration_minutes_snapshot, price_cents_snapshot, start_at, end_at, status
         ) values ($1, $2, $3, 'E2E: услуга для записи', 30, 100000, $4, $5, 'confirmed')`,
        [appointmentId, telegramUserRowId, serviceId, startAt.toISOString(), endAt.toISOString()]
      );
    } finally {
      await pg.end();
    }
  });

  test.afterAll(async () => {
    if (!env) return;
    const pg = new Client({ connectionString: env.databaseUrl });
    await pg.connect();
    try {
      await pg.query(`delete from public.appointments where id = $1`, [appointmentId]);
      await pg.query(`delete from public.telegram_users where id = $1`, [telegramUserRowId]);
      await pg.query(`delete from public.services where id = $1`, [serviceId]);
    } finally {
      await pg.end();
    }
  });

  test.beforeEach(async ({ page }) => {
    await loginAsAdmin(page);
  });

  test("10. записи фильтруются по имени клиента", async ({ page }) => {
    await page.goto("/admin/appointments");
    await page.getByLabel("Имя клиента").fill(clientFirstName);
    await page.getByRole("button", { name: "Применить" }).click();

    await expect(page.getByRole("cell", { name: clientFirstName })).toBeVisible();
  });

  test("11. статус confirmed меняется на completed", async ({ page }) => {
    await page.goto(`/admin/appointments?clientName=${encodeURIComponent(clientFirstName)}`);

    const row = page.locator("tr", { hasText: clientFirstName });
    await row.getByRole("button", { name: "Завершить" }).click();

    await expect(row.getByText("Статус записи обновлён.")).toBeVisible();
    await page.reload();
    const updatedRow = page.locator("tr", { hasText: clientFirstName });
    await expect(updatedRow.getByText("Завершена")).toBeVisible();
  });
});
