import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Настоящий тест конкурентной гонки на уровне САМОЙ ФУНКЦИИ
 * public.reserve_appointment — в отличие от double-booking-race.test.ts,
 * который гоняет сырой INSERT напрямую в appointments. Два независимых
 * TCP-подключения одновременно вызывают reserve_appointment на один и тот
 * же слот одной услуги; ровно один вызов должен создать запись, второй —
 * упасть с SQLSTATE 23P01 (exclusion constraint), который серверный
 * TypeScript-слой (lib/booking/errors.ts) преобразует в доменный код
 * SLOT_TAKEN.
 *
 * Честное разделение на два теста, а не один:
 *   1. Ниже — реальная гонка на уровне PostgreSQL через прямой вызов
 *      функции пакетом `pg` (тем же путём, которым уже идёт вся остальная
 *      интеграционная база этого репозитория). Подтверждает, что exclusion
 *      constraint защищает именно вызов reserve_appointment, а не только
 *      прямой INSERT в обход бизнес-логики функции.
 *   2. Что 23P01 сопоставляется с SLOT_TAKEN на TypeScript-уровне —
 *      проверяется отдельно, на структуре ошибки ровно такой формы, какую
 *      реально бросил PostgreSQL в первом тесте. Полный сквозной путь
 *      через @supabase/supabase-js .rpc() поверх настоящего HTTP PostgREST
 *      здесь не тестируется: в этой песочнице нет живого Supabase-проекта,
 *      только прямое подключение к PostgreSQL, которое использует и весь
 *      остальной набор integration-тестов. Утверждать, что HTTP-путь через
 *      supabase-js работает, было бы недоказанным — честно не утверждаем.
 *
 * Требует TEST_DATABASE_URL, как и остальные интеграционные тесты (та же
 * bookingbot_test, что готовит `npm run test:sql`). Без переменной оба
 * теста пропускаются, а не падают.
 *
 * npm run test:integration
 */

const connectionString = process.env.TEST_DATABASE_URL;

function isoDatePlusDays(days: number): string {
  const base = new Date();
  base.setUTCDate(base.getUTCDate() + days);
  return base.toISOString().slice(0, 10);
}

describe.skipIf(!connectionString)(
  "конкурентная гонка на реальном вызове public.reserve_appointment",
  () => {
    let setupClient: Client;
    let clientA: Client;
    let clientB: Client;

    // Разные тестовые клиенты гонятся за один и тот же слот одной услуги.
    const telegramUserIdA = `81${Date.now()}`;
    const telegramUserIdB = `82${Date.now()}`;
    const userRowIdA = randomUUID();
    const userRowIdB = randomUUID();
    const serviceId = randomUUID();
    const workingHoursIds: string[] = [];

    const startAt = `${isoDatePlusDays(12)}T11:00:00+03:00`;

    let savedSettings: {
      booking_horizon_days: number;
      min_booking_notice_minutes: number;
      timezone: string;
    };

    beforeAll(async () => {
      setupClient = new Client({ connectionString });
      await setupClient.connect();

      const { rows } = await setupClient.query(
        `select booking_horizon_days, min_booking_notice_minutes, timezone
           from public.business_settings where id = 1`
      );
      savedSettings = rows[0];

      await setupClient.query(
        `update public.business_settings
            set timezone = 'Europe/Moscow',
                booking_horizon_days = 90,
                min_booking_notice_minutes = 0
          where id = 1`
      );

      await setupClient.query(
        `insert into public.telegram_users (id, telegram_user_id) values ($1, $2), ($3, $4)`,
        [userRowIdA, telegramUserIdA, userRowIdB, telegramUserIdB]
      );
      await setupClient.query(
        `insert into public.services (id, name, duration_minutes, price_cents, is_active)
         values ($1, 'Гоночный тест reserve_appointment', 60, 100000, true)`,
        [serviceId]
      );

      // Рабочие часы на все дни недели — выбранная дата заведомо попадает
      // в расписание независимо от дня недели.
      for (let weekday = 0; weekday <= 6; weekday += 1) {
        const id = randomUUID();
        workingHoursIds.push(id);
        await setupClient.query(
          `insert into public.working_hours (id, weekday, start_time, end_time, is_active)
           values ($1, $2, '08:00', '22:00', true)`,
          [id, weekday]
        );
      }

      clientA = new Client({ connectionString });
      clientB = new Client({ connectionString });
      await clientA.connect();
      await clientB.connect();

      // Вызов должен реально идти от имени service_role — единственной
      // роли с GRANT EXECUTE на reserve_appointment, тем же путём, что и
      // серверный бот.
      await clientA.query("set role service_role");
      await clientB.query("set role service_role");
    });

    afterAll(async () => {
      await setupClient.query(
        `delete from public.appointments where telegram_user_id in ($1, $2)`,
        [userRowIdA, userRowIdB]
      );
      await setupClient.query(`delete from public.working_hours where id = any($1)`, [
        workingHoursIds,
      ]);
      await setupClient.query(`delete from public.services where id = $1`, [serviceId]);
      await setupClient.query(
        `delete from public.telegram_users where id in ($1, $2)`,
        [userRowIdA, userRowIdB]
      );
      if (savedSettings) {
        await setupClient.query(
          `update public.business_settings
              set timezone = $1, booking_horizon_days = $2,
                  min_booking_notice_minutes = $3
            where id = 1`,
          [
            savedSettings.timezone,
            savedSettings.booking_horizon_days,
            savedSettings.min_booking_notice_minutes,
          ]
        );
      }
      await clientA?.end();
      await clientB?.end();
      await setupClient?.end();
    });

    it("два одновременных вызова reserve_appointment на один слот: ровно один успешен, второй -> 23P01", async () => {
      const sql = `select * from public.reserve_appointment($1, $2, $3, $4)`;

      // Оба вызова запускаются без ожидания друг друга — настоящая гонка
      // на двух независимых backend-процессах PostgreSQL, а не
      // последовательное выполнение в одном процессе Node.js.
      const results = await Promise.allSettled([
        clientA.query(sql, [telegramUserIdA, serviceId, startAt, null]),
        clientB.query(sql, [telegramUserIdB, serviceId, startAt, null]),
      ]);

      const fulfilled = results.filter(
        (r): r is PromiseFulfilledResult<import("pg").QueryResult> =>
          r.status === "fulfilled"
      );
      const rejected = results.filter(
        (r): r is PromiseRejectedResult => r.status === "rejected"
      );

      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect(rejected[0].reason).toMatchObject({ code: "23P01" });

      const { rows } = await setupClient.query(
        `select count(*)::int as count from public.appointments
          where service_id = $1 and start_at = $2
            and status in ('confirmed', 'completed', 'no_show')`,
        [serviceId, startAt]
      );
      expect(rows[0].count).toBe(1);
    });

    it("23P01 сопоставляется с доменным кодом SLOT_TAKEN на TypeScript-уровне", async () => {
      // Сквозной вызов через @supabase/supabase-js .rpc() (реальный HTTP
      // PostgREST) здесь не воспроизводим — нет живого Supabase-проекта.
      // Честно проверяем то, что реально можем: чистую функцию
      // преобразования кода на структуре ошибки ровно такой формы
      // ({ code: "23P01" }), какую только что реально бросил PostgreSQL в
      // предыдущем тесте (см. tests/unit/booking-errors.test.ts — там же
      // самое сопоставление проверяется как чистый unit-тест).
      const { sqlstateToBookingCode, toBookingError } = await import(
        "@/lib/booking/errors"
      );
      expect(sqlstateToBookingCode("23P01")).toBe("SLOT_TAKEN");
      expect(
        toBookingError({ code: "23P01", message: "exclusion_violation" }).code
      ).toBe("SLOT_TAKEN");
    });
  }
);
