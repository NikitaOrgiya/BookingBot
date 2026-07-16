import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Настоящий тест конкурентной гонки на двух независимых подключениях к
 * PostgreSQL — в отличие от supabase/tests/permissions.test.sql, где обе
 * вставки выполняются последовательно в одной сессии и проверяют только
 * то, что exclusion constraint определён правильно.
 *
 * Здесь два реальных TCP-соединения одновременно пытаются вставить
 * пересекающийся интервал времени в public.appointments. PostgreSQL
 * обрабатывает каждое соединение в отдельном backend-процессе, поэтому
 * это настоящая гонка на уровне базы данных, а не имитация в одном
 * процессе Node.js.
 *
 * Требует переменную окружения TEST_DATABASE_URL — строку подключения к
 * PostgreSQL с уже применёнными миграциями (supabase/migrations) и
 * bootstrap-скриптом supabase/tests/local_bootstrap.sql (роли
 * anon/authenticated/service_role и заглушка схемы auth). Роль в строке
 * подключения должна иметь возможность выполнить `set role service_role`
 * (проще всего — подключаться суперпользователем, как в CI/локальной
 * разработке). Если переменная не задана, тест пропускается, а не падает.
 *
 * npm run test:integration
 */

const connectionString = process.env.TEST_DATABASE_URL;

describe.skipIf(!connectionString)(
  "конкурентное бронирование: реальная гонка на двух подключениях",
  () => {
    let setupClient: Client;
    let clientA: Client;
    let clientB: Client;

    const telegramUserId = Number(`9${Date.now()}`.slice(0, 15));
    const telegramUserRowId = randomUUID();
    const serviceId = randomUUID();

    // Один и тот же интервал для обеих вставок — гарантированное
    // пересечение независимо от точного времени выполнения запросов.
    const startAt = "2027-03-01T10:00:00+03:00";
    const endAt = "2027-03-01T11:00:00+03:00";

    beforeAll(async () => {
      setupClient = new Client({ connectionString });
      await setupClient.connect();

      // Тестовые фикстуры создаются под правами подключения (суперюзер
      // в локальной разработке/CI), поэтому GRANT/RLS сервисных ролей
      // здесь не участвуют — это только подготовка данных.
      await setupClient.query(
        `insert into public.telegram_users (id, telegram_user_id) values ($1, $2)`,
        [telegramUserRowId, telegramUserId]
      );
      await setupClient.query(
        `insert into public.services (id, name, duration_minutes, price_cents, is_active)
         values ($1, 'Гоночный тест', 60, 100000, true)`,
        [serviceId]
      );

      clientA = new Client({ connectionString });
      clientB = new Client({ connectionString });
      await clientA.connect();
      await clientB.connect();

      // Вставки должны реально идти от имени service_role (единственная
      // роль с GRANT INSERT на appointments), а не от суперпользователя,
      // иначе тест проверял бы не тот путь доступа, которым пользуется
      // сервер бота.
      await clientA.query("set role service_role");
      await clientB.query("set role service_role");
    });

    afterAll(async () => {
      // Очистка выполняется под правами подключения setupClient
      // (суперпользователь), поскольку service_role не имеет DELETE на
      // appointments/services/telegram_users.
      await setupClient.query(
        `delete from public.appointments where telegram_user_id = $1`,
        [telegramUserRowId]
      );
      await setupClient.query(`delete from public.services where id = $1`, [
        serviceId,
      ]);
      await setupClient.query(
        `delete from public.telegram_users where id = $1`,
        [telegramUserRowId]
      );

      await clientA?.end();
      await clientB?.end();
      await setupClient?.end();
    });

    it("ровно одна из двух одновременных вставок одного слота успешна, вторая отклонена SQLSTATE 23P01 или 40P01", async () => {
      const insertSql = `
        insert into public.appointments (
          telegram_user_id, service_id, service_name_snapshot,
          duration_minutes_snapshot, price_cents_snapshot, start_at, end_at
        ) values ($1, $2, 'Гоночный тест', 60, 100000, $3, $4)
        returning id
      `;
      const params = [telegramUserRowId, serviceId, startAt, endAt];

      // Оба запроса запускаются без ожидания друг друга — именно это
      // создаёт настоящую конкурентную гонку на двух независимых
      // backend-процессах PostgreSQL, а не последовательное выполнение.
      const results = await Promise.allSettled([
        clientA.query(insertSql, params),
        clientB.query(insertSql, params),
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
      // Это низкоуровневый тест сырого INSERT в обход reserve_appointment
      // (и, следовательно, в обход retry-логики lib/booking/
      // reserve-appointment.ts) — честная гонка на GiST exclusion
      // constraint под конкурентной вставкой пересекающихся интервалов
      // документированно может дать проигравшей транзакции ЛИБО штатный
      // 23P01 (exclusion_violation), ЛИБО, реже, 40P01 (deadlock_detected,
      // конкурирующие блокировки страниц индекса) — оба варианта
      // легитимны на этом уровне. Гарантию "проигравший ВСЕГДА получает
      // стабильный SLOT_TAKEN, никогда INTERNAL_ERROR" на прикладном
      // TypeScript-уровне (с retry на 40P01) проверяет отдельный тест —
      // см. tests/integration/reserve-appointment-race.test.ts, секция
      // "конкурентная гонка через прикладной путь reserveAppointment".
      expect(["23P01", "40P01"]).toContain(
        (rejected[0].reason as { code?: string }).code
      );

      // В таблице реально осталась ровно одна запись на этот интервал —
      // не ноль и не две, независимо от того, каким SQLSTATE отклонился
      // проигравший запрос.
      const { rows } = await setupClient.query(
        `select count(*)::int as count from public.appointments where telegram_user_id = $1`,
        [telegramUserRowId]
      );
      expect(rows[0].count).toBe(1);
    });
  }
);
