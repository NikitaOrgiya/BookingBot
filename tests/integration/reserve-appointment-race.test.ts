import { randomUUID } from "node:crypto";
import { Client, Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * Настоящий тест конкурентной гонки на уровне САМОЙ ФУНКЦИИ
 * public.reserve_appointment — в отличие от double-booking-race.test.ts,
 * который гоняет сырой INSERT напрямую в appointments. Два независимых
 * TCP-подключения одновременно вызывают reserve_appointment на один и тот
 * же слот одной услуги; ровно один вызов должен создать запись, второй —
 * упасть с SQLSTATE 23P01 (exclusion constraint) либо, реже, 40P01
 * (deadlock_detected — документированное поведение PostgreSQL при
 * конкурентной вставке пересекающихся интервалов в таблицу с GiST
 * exclusion constraint под нагрузкой, не баг этого проекта).
 *
 * Три уровня тестирования в этом файле, каждый честно проверяет только то,
 * что реально может:
 *   1. Низкоуровневая гонка на уровне PostgreSQL через прямой вызов функции
 *      пакетом `pg` — подтверждает, что exclusion constraint защищает
 *      именно вызов reserve_appointment. Проигравший может получить ЛИБО
 *      23P01, ЛИБО 40P01 — оба варианта здесь легитимны (сырой SQLSTATE,
 *      без прикладного retry).
 *   2. Что 23P01 сопоставляется с SLOT_TAKEN на TypeScript-уровне —
 *      чистая функция преобразования кода на структуре ошибки ровно такой
 *      формы, какую реально бросил PostgreSQL в первом тесте.
 *   3. Конкурентная гонка ЧЕРЕЗ ПРИКЛАДНОЙ ПУТЬ: настоящий
 *      lib/booking/reserve-appointment.ts::reserveAppointment() (включая
 *      retry-логику на 40P01) вызывается напрямую, с замоканным ТОЛЬКО
 *      транспортом (getServiceSupabaseClient().rpc) — сама функция rpc()
 *      выполняет ту же самую SQL-функцию через реальный `pg`-пул с
 *      несколькими физическими соединениями (для настоящей конкурентности
 *      на уровне PostgreSQL, а не последовательного выполнения на одном
 *      соединении). Это честно, а не "мокает саму гонку": подменяется
 *      только HTTP-транспорт supabase-js/PostgREST, которого в этой
 *      песочнице нет (см. README) — вся остальная логика reserveAppointment
 *      (retry-цикл, backoff, преобразование ошибок в BookingError)
 *      выполняется реальным, невтронутым кодом. Проверяет ту самую
 *      гарантию, которую требует аудит: проигравший ВСЕГДА получает
 *      стабильный SLOT_TAKEN, никогда INTERNAL_ERROR.
 *
 * Требует TEST_DATABASE_URL, как и остальные интеграционные тесты (та же
 * bookingbot_test, что готовит `npm run test:sql`). Без переменной все
 * тесты пропускаются, а не падают.
 *
 * npm run test:integration
 */

const connectionString = process.env.TEST_DATABASE_URL;

function isoDatePlusDays(days: number): string {
  const base = new Date();
  base.setUTCDate(base.getUTCDate() + days);
  return base.toISOString().slice(0, 10);
}

// Пул для теста №3 (прикладной путь). Инициализируется в beforeAll, но сам
// vi.mock должен быть объявлен на верхнем уровне модуля (hoisting) — отсюда
// объект-обёртка "racePoolHolder" вместо прямой переменной: фабрика мока
// обращается к racePoolHolder.pool лениво, к моменту первого реального
// вызова reserveAppointment() пул уже проинициализирован.
const racePoolHolder: { pool: Pool | undefined } = { pool: undefined };

vi.mock("@/lib/supabase/server-client", () => ({
  getServiceSupabaseClient: () => ({
    rpc: async (fnName: string, params: Record<string, unknown>) => {
      const pool = racePoolHolder.pool;
      if (!pool) {
        throw new Error("racePoolHolder.pool не инициализирован (beforeAll ещё не выполнился)");
      }
      if (fnName !== "reserve_appointment") {
        throw new Error(`Неожиданный вызов rpc() в тестовом моке: ${fnName}`);
      }
      const client = await pool.connect();
      try {
        // Тот же путь доступа, что и у реального бота: единственная роль
        // с GRANT EXECUTE на reserve_appointment — service_role.
        await client.query("set role service_role");
        const { rows } = await client.query(
          `select * from public.reserve_appointment($1, $2, $3, $4)`,
          [
            params.p_telegram_user_id,
            params.p_service_id,
            params.p_start_at,
            params.p_client_note ?? null,
          ]
        );
        return { data: rows[0], error: null };
      } catch (err) {
        const pgErr = err as { code?: string; message?: string };
        return { data: null, error: { code: pgErr.code, message: pgErr.message } };
      } finally {
        client.release();
      }
    },
  }),
}));

import { reserveAppointment } from "@/lib/booking/reserve-appointment";
import { BookingError } from "@/lib/booking/errors";

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

      racePoolHolder.pool = new Pool({ connectionString });
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
      await racePoolHolder.pool?.end();
    });

    it("два одновременных вызова reserve_appointment на один слот: ровно один успешен, второй -> 23P01 или 40P01 (сырой SQLSTATE, без прикладного retry)", async () => {
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
      // Низкоуровневый прямой вызов функции в обход lib/booking/
      // reserve-appointment.ts (и его retry на 40P01) — оба SQLSTATE
      // легитимны здесь. Гарантию для прикладного слоя (всегда
      // стабильный SLOT_TAKEN) проверяет тест "конкурентная гонка через
      // прикладной путь" ниже.
      expect(["23P01", "40P01"]).toContain(
        (rejected[0].reason as { code?: string }).code
      );

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
      // PostgREST) здесь не воспроизводим напрямую этим способом — см.
      // тест "через прикладной путь" ниже, где реальный reserveAppointment()
      // вызывается против настоящего конкурентного PostgreSQL с замоканным
      // только транспортом. Здесь же — чистая функция преобразования кода
      // на структуре ошибки ровно такой формы ({ code: "23P01" }), какую
      // реально бросил PostgreSQL в первом тесте (см. tests/unit/
      // booking-errors.test.ts — то же сопоставление как чистый unit-тест).
      const { sqlstateToBookingCode, toBookingError } = await import(
        "@/lib/booking/errors"
      );
      expect(sqlstateToBookingCode("23P01")).toBe("SLOT_TAKEN");
      expect(
        toBookingError({ code: "23P01", message: "exclusion_violation" }).code
      ).toBe("SLOT_TAKEN");
    });

    describe("конкурентная гонка через прикладной путь reserveAppointment (включая retry на 40P01)", () => {
      const RUNS = 50;

      it(
        `${RUNS} независимых конкурентных пар: ровно один успех и один стабильный SLOT_TAKEN на каждую пару, ноль INTERNAL_ERROR, ноль дублей в БД`,
        async () => {
          const stats = {
            success: 0,
            slotTaken: 0,
            internalError: 0,
            otherErrorCodes: [] as string[],
            bothSucceeded: 0,
            bothFailed: 0,
          };

          for (let i = 0; i < RUNS; i += 1) {
            const telegramUserIdC = `71${Date.now()}${i}`;
            const telegramUserIdD = `72${Date.now()}${i}`;
            await setupClient.query(
              `insert into public.telegram_users (telegram_user_id) values ($1), ($2)`,
              [telegramUserIdC, telegramUserIdD]
            );
            // Отдельный слот на каждую итерацию (в пределах горизонта в
            // 90 дней, заданного в beforeAll), чтобы итерации не гонялись
            // друг с другом — конкурируют только два вызова ВНУТРИ
            // одной итерации.
            const slotStartAt = `${isoDatePlusDays(40 + (i % 45))}T09:30:00+03:00`;

            const results = await Promise.allSettled([
              reserveAppointment({
                telegramUserId: telegramUserIdC,
                serviceId,
                startAt: slotStartAt,
              }),
              reserveAppointment({
                telegramUserId: telegramUserIdD,
                serviceId,
                startAt: slotStartAt,
              }),
            ]);

            const fulfilledCount = results.filter((r) => r.status === "fulfilled").length;
            const rejectedResults = results.filter(
              (r): r is PromiseRejectedResult => r.status === "rejected"
            );

            if (fulfilledCount === 2) stats.bothSucceeded += 1;
            if (fulfilledCount === 1) stats.success += 1;
            if (rejectedResults.length === 2) stats.bothFailed += 1;

            for (const r of rejectedResults) {
              expect(r.reason).toBeInstanceOf(BookingError);
              const code = (r.reason as InstanceType<typeof BookingError>).code;
              if (code === "SLOT_TAKEN") {
                stats.slotTaken += 1;
              } else if (code === "INTERNAL_ERROR") {
                stats.internalError += 1;
              } else {
                stats.otherErrorCodes.push(code);
              }
            }

            // Ровно одна запись в БД на этот слот — не ноль и не две,
            // независимо от того, сколько попыток/повторов потребовалось
            // внутри reserveAppointment.
            const { rows } = await setupClient.query(
              `select count(*)::int as count from public.appointments
                where service_id = $1 and start_at = $2
                  and status in ('confirmed', 'completed', 'no_show')`,
              [serviceId, slotStartAt]
            );
            expect(rows[0].count).toBe(1);

            await setupClient.query(
              `delete from public.appointments where telegram_user_id in (
                 select id from public.telegram_users where telegram_user_id in ($1, $2)
               )`,
              [telegramUserIdC, telegramUserIdD]
            );
            await setupClient.query(
              `delete from public.telegram_users where telegram_user_id in ($1, $2)`,
              [telegramUserIdC, telegramUserIdD]
            );
          }

          console.log(
            `[reserve-appointment-race:прикладной путь] ${RUNS} прогонов:`,
            JSON.stringify(stats)
          );

          expect(stats.success).toBe(RUNS);
          expect(stats.slotTaken).toBe(RUNS);
          expect(stats.internalError).toBe(0);
          expect(stats.otherErrorCodes).toEqual([]);
          expect(stats.bothSucceeded).toBe(0);
          expect(stats.bothFailed).toBe(0);
        },
        120000
      );
    });
  }
);
