import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Интеграционные тесты Этапа 5 (автоматические Telegram-напоминания) через
 * реальный PostgreSQL — как и tests/integration/admin-functions.test.ts,
 * lib/reminders/*.ts используют supabase-js (PostgREST), а локально
 * PostgREST не поднят, поэтому здесь напрямую вызываются те же SQL-объекты
 * (триггеры, RPC), которые реально используют lib/reminders/{repository,
 * worker}.ts — под тем же service_role, под которым выполняется cron.
 *
 * Единственная часть, которую в принципе невозможно честно проверить одной
 * pgTAP-сессией (supabase/tests/appointment_reminders.test.sql), —
 * настоящая конкурентная гонка за одну и ту же due-строку между двумя
 * независимыми подключениями (см. "claim: параллельный вызов..." ниже) —
 * тот же принцип, что и tests/integration/double-booking-race.test.ts.
 *
 * Требует TEST_DATABASE_URL (см. npm run test:sql). Без переменной весь
 * набор пропускается, а не падает и не подделывает результат.
 *
 * npm run test:integration
 */

const connectionString = process.env.TEST_DATABASE_URL;

function isoPlusMinutes(minutes: number): string {
  return new Date(Date.now() + minutes * 60_000).toISOString();
}

describe.skipIf(!connectionString)("Этап 5: автоматические Telegram-напоминания", () => {
  let setup: Client; // суперпользователь — фикстуры/очистка/диагностика
  let svcA: Client; // service_role — основной путь (тот же, что у worker.ts)
  let svcB: Client; // service_role — второе независимое подключение для гонки claim

  const telegramUserRowId = randomUUID();
  const telegramUserId = Number(`8${Date.now()}`.slice(0, 15));
  const serviceId = randomUUID();
  const appointmentIds: string[] = [];

  let savedReminderMinutes: {
    reminder_first_minutes: number | null;
    reminder_second_minutes: number | null;
  };

  async function insertAppointment(startMinutesFromNow: number): Promise<string> {
    const id = randomUUID();
    appointmentIds.push(id);
    const startAt = isoPlusMinutes(startMinutesFromNow);
    const endAt = isoPlusMinutes(startMinutesFromNow + 60);
    await setup.query(
      `insert into public.appointments (
         id, telegram_user_id, service_id, service_name_snapshot,
         duration_minutes_snapshot, price_cents_snapshot, start_at, end_at, status
       ) values ($1, $2, $3, 'Тест напоминаний', 60, 150000, $4, $5, 'confirmed')`,
      [id, telegramUserRowId, serviceId, startAt, endAt]
    );
    return id;
  }

  beforeAll(async () => {
    setup = new Client({ connectionString });
    await setup.connect();

    const { rows } = await setup.query(
      `select reminder_first_minutes, reminder_second_minutes
         from public.business_settings where id = 1`
    );
    savedReminderMinutes = rows[0];
    await setup.query(
      `update public.business_settings
          set reminder_first_minutes = 1440, reminder_second_minutes = 120
        where id = 1`
    );

    await setup.query(
      `insert into public.telegram_users (id, telegram_user_id) values ($1, $2)`,
      [telegramUserRowId, telegramUserId]
    );
    await setup.query(
      `insert into public.services (id, name, duration_minutes, price_cents, is_active)
       values ($1, 'Тестовая услуга Этапа 5 (integration)', 60, 150000, true)`,
      [serviceId]
    );

    svcA = new Client({ connectionString });
    svcB = new Client({ connectionString });
    await svcA.connect();
    await svcB.connect();
    await svcA.query("set role service_role");
    await svcB.query("set role service_role");
  });

  afterAll(async () => {
    await setup.query(
      `delete from public.appointment_reminders where appointment_id = any($1::uuid[])`,
      [appointmentIds]
    );
    await setup.query(`delete from public.appointments where id = any($1::uuid[])`, [
      appointmentIds,
    ]);
    await setup.query(`delete from public.services where id = $1`, [serviceId]);
    await setup.query(`delete from public.telegram_users where id = $1`, [
      telegramUserRowId,
    ]);
    await setup.query(
      `update public.business_settings
          set reminder_first_minutes = $1, reminder_second_minutes = $2
        where id = 1`,
      [savedReminderMinutes.reminder_first_minutes, savedReminderMinutes.reminder_second_minutes]
    );

    await svcA?.end();
    await svcB?.end();
    await setup?.end();
  });

  it("подтверждённая запись далеко в будущем получает оба напоминания (24h и 2h)", async () => {
    const appointmentId = await insertAppointment(60 * 24 * 3); // через 3 дня

    const { rows } = await setup.query(
      `select reminder_type, status from public.appointment_reminders
        where appointment_id = $1 order by reminder_type`,
      [appointmentId]
    );

    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.reminder_type)).toEqual(["24h", "2h"]);
    expect(rows.every((r) => r.status === "pending")).toBe(true);
  });

  it("запись, созданная менее чем за 2 часа до начала, не получает ни одного напоминания", async () => {
    const appointmentId = await insertAppointment(90);

    const { rows } = await setup.query(
      `select count(*)::int as n from public.appointment_reminders where appointment_id = $1`,
      [appointmentId]
    );

    expect(rows[0].n).toBe(0);
  });

  it("отмена подтверждённой записи переводит её pending-напоминания в skipped", async () => {
    const appointmentId = await insertAppointment(60 * 24 * 5); // через 5 дней

    await setup.query(
      `update public.appointments set status = 'cancelled', cancelled_at = now() where id = $1`,
      [appointmentId]
    );

    const { rows } = await setup.query(
      `select distinct status from public.appointment_reminders where appointment_id = $1`,
      [appointmentId]
    );

    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("skipped");
  });

  it("claim не выдаёт напоминание для уже начавшейся записи, даже если строка формально due", async () => {
    // Прошедшая запись — вставляется напрямую с интервалом в прошлом
    // (изолированным по времени от остальных фикстур этого файла).
    const id = randomUUID();
    appointmentIds.push(id);
    await setup.query(
      `insert into public.appointments (
         id, telegram_user_id, service_id, service_name_snapshot,
         duration_minutes_snapshot, price_cents_snapshot, start_at, end_at, status
       ) values ($1, $2, $3, 'Тест напоминаний', 60, 150000, now() - interval '3 hours', now() - interval '2 hours', 'confirmed')`,
      [id, telegramUserRowId, serviceId]
    );
    await setup.query(
      `insert into public.appointment_reminders (appointment_id, reminder_type, scheduled_for, next_attempt_at)
       values ($1, '24h', now() - interval '1 minute', now() - interval '1 minute')`,
      [id]
    );

    const { rows } = await svcA.query(
      `select * from public.claim_due_appointment_reminders(50) where appointment_id = $1`,
      [id]
    );

    expect(rows).toHaveLength(0);
  });

  it("claim: параллельный вызов с двух независимых подключений не забирает одну и ту же строку дважды", async () => {
    const appointmentId = await insertAppointment(60 * 24 * 2); // через 2 дня
    await setup.query(
      `update public.appointment_reminders
          set scheduled_for = now() - interval '1 minute',
              next_attempt_at = now() - interval '1 minute'
        where appointment_id = $1 and reminder_type = '2h'`,
      [appointmentId]
    );

    // Оба вызова запускаются без ожидания друг друга — настоящая гонка на
    // двух независимых backend-процессах PostgreSQL за одну и ту же
    // строку (FOR UPDATE SKIP LOCKED), не последовательное выполнение.
    const [resultA, resultB] = await Promise.all([
      svcA.query(
        `select * from public.claim_due_appointment_reminders(1) where appointment_id = $1`,
        [appointmentId]
      ),
      svcB.query(
        `select * from public.claim_due_appointment_reminders(1) where appointment_id = $1`,
        [appointmentId]
      ),
    ]);

    const totalClaimed = resultA.rows.length + resultB.rows.length;
    expect(totalClaimed).toBe(1);

    const { rows: finalRows } = await setup.query(
      `select status, attempt_count from public.appointment_reminders
        where appointment_id = $1 and reminder_type = '2h'`,
      [appointmentId]
    );
    expect(finalRows[0].status).toBe("processing");
    expect(finalRows[0].attempt_count).toBe(1);
  });

  it("повторный claim не забирает уже sent-напоминание", async () => {
    const appointmentId = await insertAppointment(60 * 24 * 2 + 90);
    await setup.query(
      `update public.appointment_reminders
          set scheduled_for = now() - interval '1 minute',
              next_attempt_at = now() - interval '1 minute'
        where appointment_id = $1 and reminder_type = '2h'`,
      [appointmentId]
    );

    const { rows: claimed } = await svcA.query(
      `select * from public.claim_due_appointment_reminders(50) where appointment_id = $1`,
      [appointmentId]
    );
    expect(claimed).toHaveLength(1);

    const { rows: sentResult } = await svcA.query(
      `select public.mark_appointment_reminder_sent($1, 555) as ok`,
      [claimed[0].reminder_id]
    );
    expect(sentResult[0].ok).toBe(true);

    const { rows: reclaimed } = await svcA.query(
      `select * from public.claim_due_appointment_reminders(50) where appointment_id = $1`,
      [appointmentId]
    );
    expect(reclaimed).toHaveLength(0);
  });

  it("mark_failed (не терминально) откладывает следующую попытку — повторный claim не забирает раньше времени", async () => {
    const appointmentId = await insertAppointment(60 * 24 * 2 + 180);
    await setup.query(
      `update public.appointment_reminders
          set scheduled_for = now() - interval '1 minute',
              next_attempt_at = now() - interval '1 minute'
        where appointment_id = $1 and reminder_type = '2h'`,
      [appointmentId]
    );

    const { rows: claimed } = await svcA.query(
      `select * from public.claim_due_appointment_reminders(50) where appointment_id = $1`,
      [appointmentId]
    );
    expect(claimed).toHaveLength(1);

    await svcA.query(
      `select public.mark_appointment_reminder_failed($1, $2, $3, now() + interval '5 minutes', false)`,
      [claimed[0].reminder_id, "TELEGRAM_500", "Telegram API 500: Internal Server Error"]
    );

    const { rows: tooEarly } = await svcA.query(
      `select * from public.claim_due_appointment_reminders(50) where appointment_id = $1`,
      [appointmentId]
    );
    expect(tooEarly).toHaveLength(0);

    // Двигаем next_attempt_at в прошлое — имитируем "время настало".
    await setup.query(
      `update public.appointment_reminders
          set next_attempt_at = now() - interval '1 minute'
        where appointment_id = $1 and reminder_type = '2h'`,
      [appointmentId]
    );
    const { rows: nowDue } = await svcA.query(
      `select * from public.claim_due_appointment_reminders(50) where appointment_id = $1`,
      [appointmentId]
    );
    expect(nowDue).toHaveLength(1);
    expect(nowDue[0].attempt_count).toBe(2);
  });

  it("истёкший processing-lease перезахватывается claim'ом (зависший воркер не блокирует напоминание навсегда)", async () => {
    const appointmentId = await insertAppointment(60 * 24 * 2 + 270);
    // Строка "зависла" в processing 20 минут назад — дольше lease (10 мин).
    await setup.query(
      `update public.appointment_reminders
          set status = 'processing', locked_at = now() - interval '20 minutes'
        where appointment_id = $1 and reminder_type = '2h'`,
      [appointmentId]
    );

    const { rows: reclaimed } = await svcA.query(
      `select * from public.claim_due_appointment_reminders(50) where appointment_id = $1`,
      [appointmentId]
    );

    expect(reclaimed).toHaveLength(1);
    expect(reclaimed[0].attempt_count).toBe(1);
  });
});
