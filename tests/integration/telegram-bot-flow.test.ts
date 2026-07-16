import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Интеграционные тесты Telegram-бота (Этап 3) через реальный PostgreSQL —
 * тем же способом, что и tests/integration/booking-functions.test.ts:
 * lib/telegram/repositories/*.ts используют supabase-js (PostgREST), а
 * локально PostgREST не поднят, поэтому здесь напрямую воспроизводятся те
 * же SQL-операции, которые репозитории реально выполняют (тот же upsert
 * с ON CONFLICT, тот же insert/select/delete), под тем же service_role,
 * под которым выполняется бот. Это проверяет ровно те гарантии (уникальные
 * ограничения, RLS/GRANT, атомарность), от которых зависит корректность
 * репозиториев, не дублируя при этом уже протестированные unit-тестами
 * чистые функции (кодек callback_data, форматирование и т.д. — см.
 * tests/unit/telegram-*.test.ts).
 *
 * Требует TEST_DATABASE_URL (см. npm run test:sql / scripts/test-sql.sh).
 * Без переменной набор пропускается, а не падает.
 *
 * npm run test:integration
 */

const connectionString = process.env.TEST_DATABASE_URL;

function isoDatePlusDays(days: number): string {
  const base = new Date();
  base.setUTCDate(base.getUTCDate() + days);
  return base.toISOString().slice(0, 10);
}

/** Выполняет запрос и возвращает его SQLSTATE-ошибку (а не успешный
 * результат) — для тестов, которые намеренно провоцируют отказ и хотят
 * проверить именно код ошибки несколькими последующими assert'ами. */
async function queryExpectingError(
  client: Client,
  sql: string,
  params: unknown[]
): Promise<{ code?: string }> {
  try {
    await client.query(sql, params);
  } catch (err) {
    return err as { code?: string };
  }
  throw new Error(`Ожидалась ошибка запроса, но он выполнился успешно: ${sql}`);
}

describe.skipIf(!connectionString)("Telegram-бот: booking_sessions, идемпотентность, владение", () => {
  let setup: Client;
  let svc: Client;

  const serviceId = randomUUID();
  const workingHoursIds: string[] = [];

  // Диапазон telegram_update_id, зарезервированный для тестов
  // claim/complete/release ниже — достаточно широкий (100000), чтобы не
  // пересекаться ни с одним другим update_id, используемым в этом файле
  // (все они образуются от Date.now() с маленькими смещениями). Одна
  // общая afterAll-очистка по диапазону вместо cleanup в каждом тесте.
  const claimTestBaseId = Date.now() * 1000;
  let claimTestCounter = 0;
  function nextClaimTestId(): number {
    claimTestCounter += 1;
    return claimTestBaseId + claimTestCounter;
  }

  let savedSettings: {
    booking_horizon_days: number;
    min_booking_notice_minutes: number;
    cancellation_notice_minutes: number;
    timezone: string;
  };

  beforeAll(async () => {
    setup = new Client({ connectionString });
    await setup.connect();

    const { rows } = await setup.query(
      `select booking_horizon_days, min_booking_notice_minutes,
              cancellation_notice_minutes, timezone
         from public.business_settings where id = 1`
    );
    savedSettings = rows[0];

    await setup.query(
      `update public.business_settings
          set timezone = 'Europe/Moscow',
              booking_horizon_days = 90,
              min_booking_notice_minutes = 0,
              cancellation_notice_minutes = 60
        where id = 1`
    );

    await setup.query(
      `insert into public.services (id, name, duration_minutes, price_cents, is_active)
       values ($1, 'Бот: интеграционная услуга', 60, 250000, true)`,
      [serviceId]
    );

    for (let weekday = 0; weekday <= 6; weekday += 1) {
      const id = randomUUID();
      workingHoursIds.push(id);
      await setup.query(
        `insert into public.working_hours (id, weekday, start_time, end_time, is_active)
         values ($1, $2, '08:00', '22:00', true)`,
        [id, weekday]
      );
    }

    svc = new Client({ connectionString });
    await svc.connect();
    await svc.query("set role service_role");
  });

  afterAll(async () => {
    await setup.query(
      `delete from public.processed_telegram_updates
        where telegram_update_id >= $1 and telegram_update_id < $1 + 100000`,
      [claimTestBaseId]
    );
    await setup.query(`delete from public.working_hours where id = any($1)`, [
      workingHoursIds,
    ]);
    await setup.query(`delete from public.services where id = $1`, [serviceId]);
    if (savedSettings) {
      await setup.query(
        `update public.business_settings
            set timezone = $1, booking_horizon_days = $2,
                min_booking_notice_minutes = $3, cancellation_notice_minutes = $4
          where id = 1`,
        [
          savedSettings.timezone,
          savedSettings.booking_horizon_days,
          savedSettings.min_booking_notice_minutes,
          savedSettings.cancellation_notice_minutes,
        ]
      );
    }
    await svc?.end();
    await setup?.end();
  });

  describe("telegram_users: upsert (см. lib/telegram/repositories/telegram-users.ts)", () => {
    const telegramUserId = `81${Date.now()}`;
    let userRowId: string;

    afterAll(async () => {
      await setup.query(`delete from public.telegram_users where telegram_user_id = $1`, [
        telegramUserId,
      ]);
    });

    it("первый upsert создаёт профиль со всеми полями", async () => {
      const { rows } = await svc.query(
        `insert into public.telegram_users (telegram_user_id, username, first_name, last_name, language_code)
         values ($1, $2, $3, $4, $5)
         on conflict (telegram_user_id) do update set
           username = excluded.username,
           first_name = excluded.first_name,
           last_name = excluded.last_name,
           language_code = excluded.language_code
         returning id, username, first_name, last_name, language_code`,
        [telegramUserId, "ivan_ivanov", "Иван", "Иванов", "ru"]
      );
      expect(rows).toHaveLength(1);
      userRowId = rows[0].id;
      expect(rows[0].username).toBe("ivan_ivanov");
      expect(rows[0].first_name).toBe("Иван");
    });

    it("повторный upsert без username в SET не затирает уже сохранённое значение", async () => {
      // Воспроизводит upsertTelegramUser: payload включает только те поля,
      // что реально пришли в update — username здесь намеренно отсутствует
      // и в списке столбцов, и в SET, а не передаётся как null.
      const { rows } = await svc.query(
        `insert into public.telegram_users (telegram_user_id, first_name)
         values ($1, $2)
         on conflict (telegram_user_id) do update set
           first_name = excluded.first_name
         returning id, username, first_name`,
        [telegramUserId, "Иван (обновлено)"]
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].id).toBe(userRowId);
      expect(rows[0].first_name).toBe("Иван (обновлено)");
      // username не был передан в этом upsert — должен остаться прежним.
      expect(rows[0].username).toBe("ivan_ivanov");
    });
  });

  describe("booking_sessions: создание, восстановление, полная замена состояния, очистка", () => {
    const telegramUserId = `82${Date.now()}`;

    afterAll(async () => {
      await setup.query(`delete from public.booking_sessions where telegram_user_id = $1`, [
        telegramUserId,
      ]);
    });

    it("создаёт сессию на шаге choosing_service", async () => {
      const expiresAt = new Date(Date.now() + 30 * 60_000).toISOString();
      const { rows } = await svc.query(
        `insert into public.booking_sessions
           (telegram_user_id, step, selected_service_id, selected_date, selected_local_time, expires_at)
         values ($1, 'choosing_service', null, null, null, $2)
         on conflict (telegram_user_id) do update set
           step = excluded.step,
           selected_service_id = excluded.selected_service_id,
           selected_date = excluded.selected_date,
           selected_local_time = excluded.selected_local_time,
           expires_at = excluded.expires_at
         returning step, selected_service_id, selected_date, selected_local_time`,
        [telegramUserId, expiresAt]
      );
      expect(rows[0]).toMatchObject({
        step: "choosing_service",
        selected_service_id: null,
        selected_date: null,
      });
    });

    it("полностью заменяет состояние при переходе на confirming (restore читает актуальные поля)", async () => {
      const expiresAt = new Date(Date.now() + 30 * 60_000).toISOString();
      const date = isoDatePlusDays(10);
      await svc.query(
        `insert into public.booking_sessions
           (telegram_user_id, step, selected_service_id, selected_date, selected_local_time, expires_at)
         values ($1, 'confirming', $2, $3, '12:00:00', $4)
         on conflict (telegram_user_id) do update set
           step = excluded.step,
           selected_service_id = excluded.selected_service_id,
           selected_date = excluded.selected_date,
           selected_local_time = excluded.selected_local_time,
           expires_at = excluded.expires_at`,
        [telegramUserId, serviceId, date, expiresAt]
      );

      const { rows } = await svc.query(
        `select step, selected_service_id, selected_date, selected_local_time
           from public.booking_sessions where telegram_user_id = $1`,
        [telegramUserId]
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].step).toBe("confirming");
      expect(rows[0].selected_service_id).toBe(serviceId);
      expect(rows[0].selected_local_time).toBe("12:00:00");
    });

    it("telegram_user_id — первичный ключ: у клиента не может быть двух сессий одновременно", async () => {
      const { rows } = await svc.query(
        `select count(*)::int as count from public.booking_sessions where telegram_user_id = $1`,
        [telegramUserId]
      );
      expect(rows[0].count).toBe(1);
    });

    it("очистка после успешного бронирования удаляет сессию", async () => {
      await svc.query(`delete from public.booking_sessions where telegram_user_id = $1`, [
        telegramUserId,
      ]);
      const { rows } = await svc.query(
        `select 1 from public.booking_sessions where telegram_user_id = $1`,
        [telegramUserId]
      );
      expect(rows).toHaveLength(0);
    });
  });

  describe("processed_telegram_updates: crash-safe lease-модель claim/complete/release", () => {
    // Симулирует "аварию" (процесс убит между claim и complete/release):
    // клэймим с намеренно коротким lease (1с), ждём его истечения и
    // перезахватываем — ровно то поведение, которое в проде происходит
    // само по себе через locked_until, без искусственного ожидания.
    async function claimWithExpiredLease(
      updateId: number
    ): Promise<{ staleToken: string; freshResult: string; freshToken: string | null }> {
      const { rows: first } = await svc.query(
        `select * from public.claim_telegram_update($1, $2)`,
        [updateId, 1]
      );
      const staleToken = first[0].claim_token as string;
      await new Promise((resolve) => setTimeout(resolve, 1200));
      const { rows: second } = await svc.query(
        `select * from public.claim_telegram_update($1, $2)`,
        [updateId, 120]
      );
      return {
        staleToken,
        freshResult: second[0].result,
        freshToken: second[0].claim_token,
      };
    }

    it("новый claim: result = claimed, claim_token не пуст", async () => {
      const updateId = nextClaimTestId();
      const { rows } = await svc.query(
        `select * from public.claim_telegram_update($1)`,
        [updateId]
      );
      expect(rows[0].result).toBe("claimed");
      expect(rows[0].claim_token).toBeTruthy();
    });

    it("completed duplicate: после complete повторный claim того же update_id -> completed, без claim_token", async () => {
      const updateId = nextClaimTestId();
      const { rows: claimed } = await svc.query(
        `select * from public.claim_telegram_update($1)`,
        [updateId]
      );
      const { rows: completed } = await svc.query(
        `select public.complete_telegram_update($1, $2) as ok`,
        [updateId, claimed[0].claim_token]
      );
      expect(completed[0].ok).toBe(true);

      const { rows: reclaim } = await svc.query(
        `select * from public.claim_telegram_update($1)`,
        [updateId]
      );
      expect(reclaim[0].result).toBe("completed");
      expect(reclaim[0].claim_token).toBeNull();
    });

    it("активный busy claim: повторный claim до истечения lease -> busy, без claim_token", async () => {
      const updateId = nextClaimTestId();
      await svc.query(`select * from public.claim_telegram_update($1)`, [updateId]);

      const { rows } = await svc.query(
        `select * from public.claim_telegram_update($1)`,
        [updateId]
      );
      expect(rows[0].result).toBe("busy");
      expect(rows[0].claim_token).toBeNull();
    });

    it("busy обязан оставаться retryable на HTTP-уровне: webhook-handler.ts возвращает 503 (см. tests/unit/telegram-webhook-handler.test.ts) — здесь только сам факт busy, а не 'уже обработано'", async () => {
      const updateId = nextClaimTestId();
      await svc.query(`select * from public.claim_telegram_update($1)`, [updateId]);
      const { rows } = await svc.query(
        `select * from public.claim_telegram_update($1)`,
        [updateId]
      );
      // busy != completed: повторная доставка НЕ должна трактоваться как
      // "уже успешно обработано" (что оправдывало бы 2xx).
      expect(rows[0].result).not.toBe("completed");
      expect(rows[0].result).toBe("busy");
    });

    it("два параллельных одинаковых update_id: ровно один claim успешен (claimed), другой видит busy — бизнес-действие выполняется один раз", async () => {
      const updateId = nextClaimTestId();
      const clientA = new Client({ connectionString });
      const clientB = new Client({ connectionString });
      await clientA.connect();
      await clientB.connect();
      await clientA.query("set role service_role");
      await clientB.query("set role service_role");

      try {
        const claim = (client: Client) =>
          client.query(`select * from public.claim_telegram_update($1)`, [updateId]);

        const [resA, resB] = await Promise.all([claim(clientA), claim(clientB)]);
        const results = [resA.rows[0].result, resB.rows[0].result].sort();

        expect(results).toEqual(["busy", "claimed"]);
      } finally {
        await clientA.end();
        await clientB.end();
      }
    });

    it("claim без complete/release, истечение lease -> повторный claim перезахватывает с НОВЫМ claim_token", async () => {
      const updateId = nextClaimTestId();
      const { staleToken, freshResult, freshToken } = await claimWithExpiredLease(updateId);

      expect(freshResult).toBe("claimed");
      expect(freshToken).not.toBe(staleToken);
    });

    it("старый claim_token НЕ может complete claim, перезахваченный другим воркером", async () => {
      const updateId = nextClaimTestId();
      const { staleToken } = await claimWithExpiredLease(updateId);

      const { rows } = await svc.query(
        `select public.complete_telegram_update($1, $2) as ok`,
        [updateId, staleToken]
      );
      expect(rows[0].ok).toBe(false);
    });

    it("старый claim_token НЕ может release claim, перезахваченный другим воркером", async () => {
      const updateId = nextClaimTestId();
      const { staleToken } = await claimWithExpiredLease(updateId);

      const { rows } = await svc.query(
        `select public.release_telegram_update($1, $2) as ok`,
        [updateId, staleToken]
      );
      expect(rows[0].ok).toBe(false);
    });

    it("обычная ошибка: release с верным claim_token -> следующий claim немедленно успешен с НОВЫМ токеном (без ожидания lease)", async () => {
      const updateId = nextClaimTestId();
      const { rows: first } = await svc.query(
        `select * from public.claim_telegram_update($1)`,
        [updateId]
      );
      const token = first[0].claim_token;

      const { rows: released } = await svc.query(
        `select public.release_telegram_update($1, $2) as ok`,
        [updateId, token]
      );
      expect(released[0].ok).toBe(true);

      const { rows: second } = await svc.query(
        `select * from public.claim_telegram_update($1)`,
        [updateId]
      );
      expect(second[0].result).toBe("claimed");
      expect(second[0].claim_token).not.toBe(token);
    });

    it("авария после claim (ни complete, ни release не вызваны) не хоронит update навсегда: после истечения lease его снова можно заявить и завершить", async () => {
      const updateId = nextClaimTestId();
      const { freshResult, freshToken } = await claimWithExpiredLease(updateId);
      expect(freshResult).toBe("claimed");

      const { rows: completed } = await svc.query(
        `select public.complete_telegram_update($1, $2) as ok`,
        [updateId, freshToken]
      );
      expect(completed[0].ok).toBe(true);
    });

    it("успешно обработанный (completed) update_id никогда не освобождается: повтор доставки не повторяет бизнес-действие (reserve_appointment)", async () => {
      const telegramUserId = `83${Date.now()}`;
      const updateId = nextClaimTestId();
      const startAt = `${isoDatePlusDays(15)}T10:00:00+03:00`;

      await setup.query(
        `insert into public.telegram_users (telegram_user_id) values ($1)`,
        [telegramUserId]
      );

      try {
        // Первая доставка confirm-колбэка: claim -> reserve_appointment -> complete.
        const { rows: claimed } = await svc.query(
          `select * from public.claim_telegram_update($1)`,
          [updateId]
        );
        const { rows: reserved } = await svc.query(
          `select * from public.reserve_appointment($1, $2, $3, $4)`,
          [telegramUserId, serviceId, startAt, null]
        );
        expect(reserved).toHaveLength(1);
        await svc.query(`select public.complete_telegram_update($1, $2)`, [
          updateId,
          claimed[0].claim_token,
        ]);

        // Повторная доставка ТОГО ЖЕ update_id (Telegram не получил 200 с
        // первого раза) -> claim обязан вернуть completed, а не claimed —
        // поэтому reserve_appointment не должен вызываться повторно кодом
        // бота. Проверяем именно это условие claim'а.
        const { rows: reclaim } = await svc.query(
          `select * from public.claim_telegram_update($1)`,
          [updateId]
        );
        expect(reclaim[0].result).toBe("completed");

        const { rows: appointments } = await setup.query(
          `select count(*)::int as count from public.appointments
            where telegram_user_id = (select id from public.telegram_users where telegram_user_id = $1)`,
          [telegramUserId]
        );
        // Ровно одна запись — повторная доставка не создала вторую.
        expect(appointments[0].count).toBe(1);
      } finally {
        await setup.query(
          `delete from public.appointments
            where telegram_user_id = (select id from public.telegram_users where telegram_user_id = $1)`,
          [telegramUserId]
        );
        await setup.query(`delete from public.telegram_users where telegram_user_id = $1`, [
          telegramUserId,
        ]);
      }
    });

    it("успешная отмена (completed) не повторяется при повторной доставке update_id колбэка отмены", async () => {
      const telegramUserId = `84${Date.now()}`;
      const updateId = nextClaimTestId();
      const startAt = `${isoDatePlusDays(16)}T10:00:00+03:00`;

      await setup.query(
        `insert into public.telegram_users (telegram_user_id) values ($1)`,
        [telegramUserId]
      );
      const { rows: reserved } = await setup.query(
        `select * from public.reserve_appointment($1, $2, $3, $4)`,
        [telegramUserId, serviceId, startAt, null]
      );
      const appointmentId = reserved[0].id;

      try {
        const { rows: claimed } = await svc.query(
          `select * from public.claim_telegram_update($1)`,
          [updateId]
        );
        const { rows: cancelled } = await svc.query(
          `select * from public.cancel_appointment_by_client($1, $2, $3)`,
          [appointmentId, telegramUserId, null]
        );
        expect(cancelled[0].status).toBe("cancelled");
        await svc.query(`select public.complete_telegram_update($1, $2)`, [
          updateId,
          claimed[0].claim_token,
        ]);

        // Повторная доставка того же update_id колбэка отмены -> claim
        // возвращает completed, cancel_appointment_by_client не вызывается
        // повторно (что и предотвращает попадание в ALREADY_CANCELLED из-за
        // самой повторной доставки, а не из-за отдельного действия клиента).
        const { rows: reclaim } = await svc.query(
          `select * from public.claim_telegram_update($1)`,
          [updateId]
        );
        expect(reclaim[0].result).toBe("completed");
      } finally {
        await setup.query(`delete from public.appointments where id = $1`, [appointmentId]);
        await setup.query(`delete from public.telegram_users where telegram_user_id = $1`, [
          telegramUserId,
        ]);
      }
    });
  });

  describe("Бизнес-эффекты повторной доставки после аварии ДО complete_telegram_update", () => {
    it("appointment создан, но complete_telegram_update не вызван (авария) -> повторная доставка confirm НЕ создаёт дубль; своя запись обнаружима тем же запросом, что использует getOwnConfirmedAppointmentBySlot", async () => {
      const telegramUserId = `90${Date.now()}`;
      const updateId = nextClaimTestId();
      const startAt = `${isoDatePlusDays(17)}T10:00:00+03:00`;

      await setup.query(
        `insert into public.telegram_users (telegram_user_id) values ($1)`,
        [telegramUserId]
      );
      const { rows: userRows } = await setup.query(
        `select id from public.telegram_users where telegram_user_id = $1`,
        [telegramUserId]
      );
      const userRowId = userRows[0].id;

      try {
        // Первая доставка: claim (короткий lease) -> reserve_appointment
        // реально создаёт запись -> АВАРИЯ (SIGKILL) до complete_telegram_update.
        await svc.query(`select * from public.claim_telegram_update($1, $2)`, [
          updateId,
          1,
        ]);
        const { rows: reserved } = await svc.query(
          `select * from public.reserve_appointment($1, $2, $3, $4)`,
          [telegramUserId, serviceId, startAt, null]
        );
        expect(reserved).toHaveLength(1);
        const appointmentId = reserved[0].id;
        // complete_telegram_update НЕ вызывается — процесс "погиб" здесь.

        // Lease истекает, Telegram повторно доставляет тот же update_id.
        await new Promise((resolve) => setTimeout(resolve, 1200));
        const { rows: reclaimed } = await svc.query(
          `select * from public.claim_telegram_update($1)`,
          [updateId]
        );
        expect(reclaimed[0].result).toBe("claimed"); // update не похоронен навсегда

        // Повторный вызов reserve_appointment на тот же слот падает
        // (exclusion constraint) — это и есть путь, которым onConfirm в
        // lib/telegram/handlers/callbacks.ts получает SLOT_TAKEN.
        const err = await queryExpectingError(
          svc,
          `select * from public.reserve_appointment($1, $2, $3, $4)`,
          [telegramUserId, serviceId, startAt, null]
        );
        expect(["23P01", "40P01"]).toContain(err.code);

        // Прикладной слой (см. getOwnConfirmedAppointmentBySlot в
        // lib/telegram/repositories/appointments.ts) обязан находить СВОЮ
        // уже созданную запись по тому же запросу — именно это позволяет
        // onConfirm показать идемпотентный успех вместо ложного SLOT_TAKEN.
        const { rows: own } = await setup.query(
          `select id from public.appointments
            where telegram_user_id = $1 and service_id = $2 and start_at = $3 and status = 'confirmed'`,
          [userRowId, serviceId, startAt]
        );
        expect(own).toHaveLength(1);
        expect(own[0].id).toBe(appointmentId);

        // В БД ровно одна запись на этот слот — повтор не создал дубль.
        const { rows: count } = await setup.query(
          `select count(*)::int as count from public.appointments where telegram_user_id = $1`,
          [userRowId]
        );
        expect(count[0].count).toBe(1);

        await svc.query(`select public.complete_telegram_update($1, $2)`, [
          updateId,
          reclaimed[0].claim_token,
        ]);
      } finally {
        await setup.query(`delete from public.appointments where telegram_user_id = $1`, [
          userRowId,
        ]);
        await setup.query(`delete from public.telegram_users where telegram_user_id = $1`, [
          telegramUserId,
        ]);
      }
    });

    it("отмена выполнена, но авария до complete_telegram_update -> повторная отмена безопасно завершается (ALREADY_CANCELLED), владение по-прежнему проверяется", async () => {
      const telegramUserId = `91${Date.now()}`;
      const otherTelegramUserId = `92${Date.now()}`;
      const updateId = nextClaimTestId();
      const startAt = `${isoDatePlusDays(18)}T10:00:00+03:00`;

      await setup.query(
        `insert into public.telegram_users (telegram_user_id) values ($1), ($2)`,
        [telegramUserId, otherTelegramUserId]
      );
      const { rows: reserved } = await setup.query(
        `select * from public.reserve_appointment($1, $2, $3, $4)`,
        [telegramUserId, serviceId, startAt, null]
      );
      const appointmentId = reserved[0].id;

      try {
        await svc.query(`select * from public.claim_telegram_update($1, $2)`, [
          updateId,
          1,
        ]);
        const { rows: cancelled } = await svc.query(
          `select * from public.cancel_appointment_by_client($1, $2, $3)`,
          [appointmentId, telegramUserId, null]
        );
        expect(cancelled[0].status).toBe("cancelled");
        // complete_telegram_update НЕ вызывается — авария здесь.

        await new Promise((resolve) => setTimeout(resolve, 1200));
        const { rows: reclaimed } = await svc.query(
          `select * from public.claim_telegram_update($1)`,
          [updateId]
        );
        expect(reclaimed[0].result).toBe("claimed");

        // Повторная доставка отмены -> cancel_appointment_by_client снова
        // вызывается кодом бота (claim не знал, что действие уже
        // выполнено) -> ALREADY_CANCELLED (PB012), НЕ ошибка владения и НЕ
        // повторное списание/изменение записи. onCancelConfirmed трактует
        // именно этот код как безопасный идемпотентный успех.
        const err = await queryExpectingError(
          svc,
          `select * from public.cancel_appointment_by_client($1, $2, $3)`,
          [appointmentId, telegramUserId, null]
        );
        expect(err.code).toBe("PB012");

        await svc.query(`select public.complete_telegram_update($1, $2)`, [
          updateId,
          reclaimed[0].claim_token,
        ]);

        // Чужая запись по-прежнему не раскрывается и не изменяется через
        // тот же путь (владение проверяется ДО статуса в самой функции).
        const otherErr = await queryExpectingError(
          svc,
          `select * from public.cancel_appointment_by_client($1, $2, $3)`,
          [appointmentId, otherTelegramUserId, null]
        );
        expect(otherErr.code).toBe("PB010");
      } finally {
        await setup.query(`delete from public.appointments where id = $1`, [appointmentId]);
        await setup.query(
          `delete from public.telegram_users where telegram_user_id in ($1, $2)`,
          [telegramUserId, otherTelegramUserId]
        );
      }
    });
  });

  describe("appointments: изоляция по владельцу (см. lib/telegram/repositories/appointments.ts)", () => {
    const telegramUserId = `85${Date.now()}`;
    const otherTelegramUserId = `86${Date.now()}`;
    let userRowId: string;
    let otherUserRowId: string;
    let ownAppointmentId: string;
    let otherAppointmentId: string;

    beforeAll(async () => {
      const { rows } = await setup.query(
        `insert into public.telegram_users (telegram_user_id) values ($1), ($2) returning id, telegram_user_id`,
        [telegramUserId, otherTelegramUserId]
      );
      userRowId = rows.find((r) => String(r.telegram_user_id) === telegramUserId).id;
      otherUserRowId = rows.find((r) => String(r.telegram_user_id) === otherTelegramUserId).id;

      const own = await setup.query(
        `select * from public.reserve_appointment($1, $2, $3, $4)`,
        [telegramUserId, serviceId, `${isoDatePlusDays(20)}T10:00:00+03:00`, null]
      );
      ownAppointmentId = own.rows[0].id;

      const other = await setup.query(
        `select * from public.reserve_appointment($1, $2, $3, $4)`,
        [otherTelegramUserId, serviceId, `${isoDatePlusDays(20)}T11:00:00+03:00`, null]
      );
      otherAppointmentId = other.rows[0].id;

      // Прошедшая (уже состоявшаяся) запись того же клиента — не должна
      // попадать в список будущих.
      await setup.query(
        `insert into public.appointments
           (telegram_user_id, service_id, service_name_snapshot, duration_minutes_snapshot,
            price_cents_snapshot, start_at, end_at, status)
         values ($1, $2, 'Прошедшая', 60, 100000, now() - interval '10 days', now() - interval '9 days', 'confirmed')`,
        [userRowId, serviceId]
      );
    });

    afterAll(async () => {
      await setup.query(`delete from public.appointments where telegram_user_id in ($1, $2)`, [
        userRowId,
        otherUserRowId,
      ]);
      await setup.query(`delete from public.telegram_users where id in ($1, $2)`, [
        userRowId,
        otherUserRowId,
      ]);
    });

    it("подмена appointmentId чужим telegram_user_row_id ничего не возвращает (getOwnAppointmentById)", async () => {
      const { rows } = await svc.query(
        `select * from public.appointments where id = $1 and telegram_user_id = $2`,
        [otherAppointmentId, userRowId]
      );
      expect(rows).toHaveLength(0);
    });

    it("своя запись по id доступна", async () => {
      const { rows } = await svc.query(
        `select * from public.appointments where id = $1 and telegram_user_id = $2`,
        [ownAppointmentId, userRowId]
      );
      expect(rows).toHaveLength(1);
    });

    it("список предстоящих записей содержит только свои будущие confirmed-записи (listUpcomingAppointments)", async () => {
      const { rows } = await svc.query(
        `select id from public.appointments
          where telegram_user_id = $1 and status = 'confirmed' and start_at > now()
          order by start_at asc`,
        [userRowId]
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].id).toBe(ownAppointmentId);
    });
  });

  describe("SLOT_TAKEN во время подтверждения брони", () => {
    it("повторное подтверждение уже занятого слота отклоняется с 23P01 (тем же путём, что и onConfirm бота)", async () => {
      const telegramUserId = `87${Date.now()}`;
      const otherTelegramUserId = `88${Date.now()}`;
      const startAt = `${isoDatePlusDays(25)}T10:00:00+03:00`;

      await setup.query(`insert into public.telegram_users (telegram_user_id) values ($1), ($2)`, [
        telegramUserId,
        otherTelegramUserId,
      ]);

      try {
        await svc.query(`select * from public.reserve_appointment($1, $2, $3, $4)`, [
          telegramUserId,
          serviceId,
          startAt,
          null,
        ]);

        // Второй клиент дошёл до экрана подтверждения того же слота чуть
        // позже (например, оба видели его свободным одновременно) — именно
        // эту ошибку lib/telegram/handlers/callbacks.ts::onConfirm ловит
        // как BookingError("SLOT_TAKEN") и заново показывает актуальные слоты.
        await expect(
          svc.query(`select * from public.reserve_appointment($1, $2, $3, $4)`, [
            otherTelegramUserId,
            serviceId,
            startAt,
            null,
          ])
        ).rejects.toMatchObject({ code: "23P01" });
      } finally {
        await setup.query(
          `delete from public.appointments
            where telegram_user_id in (
              select id from public.telegram_users where telegram_user_id in ($1, $2)
            )`,
          [telegramUserId, otherTelegramUserId]
        );
        await setup.query(`delete from public.telegram_users where telegram_user_id in ($1, $2)`, [
          telegramUserId,
          otherTelegramUserId,
        ]);
      }
    });
  });

  describe("Полный сценарий бронирования от начала до конца", () => {
    it("upsert клиента -> переходы booking_sessions -> reserve_appointment -> очистка сессии -> появляется в «моих записях»", async () => {
      const telegramUserId = `89${Date.now()}`;
      const date = isoDatePlusDays(30);
      const startAt = `${date}T12:00:00+03:00`;

      // 1. /start — регистрация клиента.
      const { rows: userRows } = await svc.query(
        `insert into public.telegram_users (telegram_user_id, first_name)
         values ($1, $2)
         on conflict (telegram_user_id) do update set first_name = excluded.first_name
         returning id`,
        [telegramUserId, "Полный сценарий"]
      );
      const userRowId = userRows[0].id;

      try {
        // 2. /book -> choosing_service.
        const expiresAt = () => new Date(Date.now() + 30 * 60_000).toISOString();
        await svc.query(
          `insert into public.booking_sessions
             (telegram_user_id, step, selected_service_id, selected_date, selected_local_time, expires_at)
           values ($1, 'choosing_service', null, null, null, $2)
           on conflict (telegram_user_id) do update set
             step = excluded.step, selected_service_id = excluded.selected_service_id,
             selected_date = excluded.selected_date, selected_local_time = excluded.selected_local_time,
             expires_at = excluded.expires_at`,
          [telegramUserId, expiresAt()]
        );

        // 3. Услуга выбрана -> choosing_date.
        await svc.query(
          `update public.booking_sessions
              set step = 'choosing_date', selected_service_id = $2, expires_at = $3
            where telegram_user_id = $1`,
          [telegramUserId, serviceId, expiresAt()]
        );

        // 4. Дата выбрана -> choosing_slot.
        await svc.query(
          `update public.booking_sessions
              set step = 'choosing_slot', selected_date = $2, expires_at = $3
            where telegram_user_id = $1`,
          [telegramUserId, date, expiresAt()]
        );

        // 5. Время выбрано -> confirming.
        await svc.query(
          `update public.booking_sessions
              set step = 'confirming', selected_local_time = '12:00:00', expires_at = $2
            where telegram_user_id = $1`,
          [telegramUserId, expiresAt()]
        );

        const { rows: sessionRows } = await svc.query(
          `select step, selected_service_id, selected_date, selected_local_time
             from public.booking_sessions where telegram_user_id = $1`,
          [telegramUserId]
        );
        expect(sessionRows[0]).toMatchObject({
          step: "confirming",
          selected_service_id: serviceId,
          selected_local_time: "12:00:00",
        });

        // 6. Подтверждение -> reserve_appointment.
        const { rows: appointmentRows } = await svc.query(
          `select * from public.reserve_appointment($1, $2, $3, $4)`,
          [telegramUserId, serviceId, startAt, null]
        );
        expect(appointmentRows).toHaveLength(1);
        const appointmentId = appointmentRows[0].id;

        // 7. Сессия очищается после успешного бронирования.
        await svc.query(`delete from public.booking_sessions where telegram_user_id = $1`, [
          telegramUserId,
        ]);
        const { rows: clearedSession } = await svc.query(
          `select 1 from public.booking_sessions where telegram_user_id = $1`,
          [telegramUserId]
        );
        expect(clearedSession).toHaveLength(0);

        // 8. Запись появляется в «моих записях».
        const { rows: myBookings } = await svc.query(
          `select id from public.appointments
            where telegram_user_id = $1 and status = 'confirmed' and start_at > now()`,
          [userRowId]
        );
        expect(myBookings.map((r) => r.id)).toContain(appointmentId);
      } finally {
        await setup.query(`delete from public.booking_sessions where telegram_user_id = $1`, [
          telegramUserId,
        ]);
        await setup.query(`delete from public.appointments where telegram_user_id = $1`, [
          userRowId,
        ]);
        await setup.query(`delete from public.telegram_users where telegram_user_id = $1`, [
          telegramUserId,
        ]);
      }
    });
  });
});
