import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Интеграционные тесты функций ядра бронирования через реальный PostgreSQL
 * (пакет pg), исполняемые ролью service_role — тем же путём доступа, что и
 * серверный бот. Проверяют атомарное бронирование + snapshot услуги, отказ
 * при повторном бронировании занятого слота (23P01) и клиентскую отмену
 * (своя / чужая / поздняя / повторная).
 *
 * Как и double-booking-race.test.ts, требует TEST_DATABASE_URL (та же
 * bookingbot_test, что готовит `npm run test:sql`). Роль подключения должна
 * уметь `set role service_role` (проще всего — суперпользователь). Без
 * переменной тест пропускается, а не падает и не подделывает результат.
 *
 * npm run test:integration
 */

const connectionString = process.env.TEST_DATABASE_URL;

function isoDatePlusDays(days: number): string {
  // Смещаем «сегодня» на N дней и берём только дату (Москва = UTC+3 без DST).
  const base = new Date();
  base.setUTCDate(base.getUTCDate() + days);
  return base.toISOString().slice(0, 10);
}

describe.skipIf(!connectionString)("ядро бронирования: reserve / cancel", () => {
  let setup: Client;
  let svc: Client; // подключение, работающее как service_role

  // Telegram ID — строки, не JS number (см. lib/booking/schemas.ts): в БД
  // это bigint, а строка проходит весь путь без единого Number()/parseInt(),
  // так что терять точность негде. Разные первые цифры вместо арифметики
  // (`+ 1`, которая для строк была бы конкатенацией, а не инкрементом)
  // гарантируют уникальность между собой и от других файлов.
  const telegramUserId = `8${Date.now()}`;
  const otherTelegramUserId = `9${Date.now()}`;
  const userRowId = randomUUID();
  const otherUserRowId = randomUUID();
  const serviceId = randomUUID();
  const workingHoursIds: string[] = [];

  // Начало брони через 10 дней в 12:00 по Москве (внутри горизонта, с
  // запасом относительно любого разумного min notice).
  const startAt = `${isoDatePlusDays(10)}T12:00:00+03:00`;
  const startAt2 = `${isoDatePlusDays(10)}T13:00:00+03:00`;
  const startAt3 = `${isoDatePlusDays(10)}T14:00:00+03:00`;

  // Исходные значения настроек — восстанавливаем в конце.
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

    // Контролируемые настройки: щедрый горизонт, нулевое уведомление,
    // умеренный срок отмены. 90, а не 365 — booking_horizon_days
    // ограничен CHECK business_settings_horizon_range (1..180) из Этапа 1;
    // все даты записей в этом файле — "сегодня + 10 дней", т.е. далеко
    // внутри 90-дневного окна.
    await setup.query(
      `update public.business_settings
          set timezone = 'Europe/Moscow',
              booking_horizon_days = 90,
              min_booking_notice_minutes = 0,
              cancellation_notice_minutes = 60
        where id = 1`
    );

    await setup.query(
      `insert into public.telegram_users (id, telegram_user_id) values ($1, $2), ($3, $4)`,
      [userRowId, telegramUserId, otherUserRowId, otherTelegramUserId]
    );
    await setup.query(
      `insert into public.services (id, name, duration_minutes, price_cents, is_active)
       values ($1, 'Интеграционная услуга', 60, 150000, true)`,
      [serviceId]
    );

    // Рабочие часы на все дни недели 08:00–22:00 — чтобы выбранная дата
    // заведомо попадала в расписание независимо от дня недели.
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
      `delete from public.appointments where telegram_user_id in ($1, $2)`,
      [userRowId, otherUserRowId]
    );
    await setup.query(`delete from public.working_hours where id = any($1)`, [
      workingHoursIds,
    ]);
    await setup.query(`delete from public.services where id = $1`, [serviceId]);
    await setup.query(
      `delete from public.telegram_users where id in ($1, $2)`,
      [userRowId, otherUserRowId]
    );
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

  it("reserve_appointment создаёт запись и фиксирует snapshot услуги", async () => {
    const { rows } = await svc.query(
      `select * from public.reserve_appointment($1, $2, $3, $4)`,
      [telegramUserId, serviceId, startAt, "первый визит"]
    );
    expect(rows).toHaveLength(1);
    const appt = rows[0];
    expect(appt.service_name_snapshot).toBe("Интеграционная услуга");
    expect(appt.duration_minutes_snapshot).toBe(60);
    expect(appt.price_cents_snapshot).toBe(150000);
    expect(appt.status).toBe("confirmed");
    // end_at = start + 60 минут.
    expect(new Date(appt.end_at).getTime() - new Date(appt.start_at).getTime()).toBe(
      60 * 60 * 1000
    );
  });

  it("повторное бронирование занятого слота отклоняется с SQLSTATE 23P01", async () => {
    await expect(
      svc.query(`select * from public.reserve_appointment($1, $2, $3, $4)`, [
        telegramUserId,
        serviceId,
        startAt,
        null,
      ])
    ).rejects.toMatchObject({ code: "23P01" });
  });

  it("клиент отменяет свою запись (status = cancelled)", async () => {
    const { rows: reserved } = await svc.query(
      `select id from public.reserve_appointment($1, $2, $3, $4)`,
      [telegramUserId, serviceId, startAt2, null]
    );
    const apptId = reserved[0].id;

    const { rows } = await svc.query(
      `select * from public.cancel_appointment_by_client($1, $2, $3)`,
      [apptId, telegramUserId, "не смогу прийти"]
    );
    expect(rows[0].status).toBe("cancelled");
    expect(rows[0].cancelled_at).not.toBeNull();
    expect(rows[0].cancel_reason).toBe("не смогу прийти");

    // Повторная отмена -> ALREADY_CANCELLED (PB012).
    await expect(
      svc.query(`select public.cancel_appointment_by_client($1, $2, $3)`, [
        apptId,
        telegramUserId,
        null,
      ])
    ).rejects.toMatchObject({ code: "PB012" });
  });

  it("нельзя отменить чужую запись (APPOINTMENT_NOT_OWNED / PB010)", async () => {
    const { rows: reserved } = await svc.query(
      `select id from public.reserve_appointment($1, $2, $3, $4)`,
      [telegramUserId, serviceId, startAt3, null]
    );
    const apptId = reserved[0].id;

    await expect(
      svc.query(`select public.cancel_appointment_by_client($1, $2, $3)`, [
        apptId,
        otherTelegramUserId,
        null,
      ])
    ).rejects.toMatchObject({ code: "PB010" });
  });

  it("слишком поздняя отмена отклоняется (CANCELLATION_TOO_LATE / PB011)", async () => {
    // Запись уже существует (startAt3, confirmed). Делаем срок отмены
    // заведомо больше, чем расстояние до неё.
    await setup.query(
      `update public.business_settings set cancellation_notice_minutes = 576000 where id = 1`
    );
    const { rows } = await setup.query(
      `select id from public.appointments
        where telegram_user_id = $1 and status = 'confirmed'
        order by start_at desc limit 1`,
      [userRowId]
    );
    const apptId = rows[0].id;

    await expect(
      svc.query(`select public.cancel_appointment_by_client($1, $2, $3)`, [
        apptId,
        telegramUserId,
        null,
      ])
    ).rejects.toMatchObject({ code: "PB011" });

    await setup.query(
      `update public.business_settings set cancellation_notice_minutes = 60 where id = 1`
    );
  });

  it("нельзя отменить completed (APPOINTMENT_NOT_CANCELLABLE / PB013)", async () => {
    const { rows: reserved } = await svc.query(
      `select id from public.reserve_appointment($1, $2, $3, $4)`,
      [telegramUserId, serviceId, `${isoDatePlusDays(10)}T15:00:00+03:00`, null]
    );
    const apptId = reserved[0].id;
    await setup.query(`update public.appointments set status = 'completed' where id = $1`, [
      apptId,
    ]);

    await expect(
      svc.query(`select public.cancel_appointment_by_client($1, $2, $3)`, [
        apptId,
        telegramUserId,
        null,
      ])
    ).rejects.toMatchObject({ code: "PB013" });
  });

  it("нельзя отменить no_show (APPOINTMENT_NOT_CANCELLABLE / PB013)", async () => {
    const { rows: reserved } = await svc.query(
      `select id from public.reserve_appointment($1, $2, $3, $4)`,
      [telegramUserId, serviceId, `${isoDatePlusDays(10)}T16:00:00+03:00`, null]
    );
    const apptId = reserved[0].id;
    await setup.query(`update public.appointments set status = 'no_show' where id = $1`, [
      apptId,
    ]);

    await expect(
      svc.query(`select public.cancel_appointment_by_client($1, $2, $3)`, [
        apptId,
        telegramUserId,
        null,
      ])
    ).rejects.toMatchObject({ code: "PB013" });
  });

  it("confirmed успешно отменяется, повторная отмена -> ALREADY_CANCELLED (PB012)", async () => {
    const { rows: reserved } = await svc.query(
      `select id from public.reserve_appointment($1, $2, $3, $4)`,
      [telegramUserId, serviceId, `${isoDatePlusDays(10)}T17:00:00+03:00`, null]
    );
    const apptId = reserved[0].id;

    const { rows } = await svc.query(
      `select * from public.cancel_appointment_by_client($1, $2, $3)`,
      [apptId, telegramUserId, null]
    );
    expect(rows[0].status).toBe("cancelled");

    await expect(
      svc.query(`select public.cancel_appointment_by_client($1, $2, $3)`, [
        apptId,
        telegramUserId,
        null,
      ])
    ).rejects.toMatchObject({ code: "PB012" });
  });

  it("telegramUserId больше Number.MAX_SAFE_INTEGER не теряет точность через реальный путь pg -> bigint", async () => {
    // 9007199254740993 = Number.MAX_SAFE_INTEGER + 2. Число такого размера
    // в принципе недостижимо для реальных Telegram ID сегодня — тест
    // проверяет не реалистичность значения, а то, что ни один слой между
    // Zod-схемой и колонкой bigint не пропускает его через JS number (иначе
    // оно округлилось бы до 9007199254740992).
    const bigTelegramUserId = "9007199254740993";
    expect(String(Number(bigTelegramUserId))).not.toBe(bigTelegramUserId);

    const bigUserRowId = randomUUID();
    await setup.query(
      `insert into public.telegram_users (id, telegram_user_id) values ($1, $2)`,
      [bigUserRowId, bigTelegramUserId]
    );

    try {
      const { rows } = await svc.query(
        `select * from public.reserve_appointment($1, $2, $3, $4)`,
        [bigTelegramUserId, serviceId, `${isoDatePlusDays(10)}T18:00:00+03:00`, null]
      );
      expect(rows).toHaveLength(1);

      // Читаем telegram_user_id обратно из БД как text — если бы значение
      // где-то прошло через JS number, здесь оно бы отличалось.
      const { rows: stored } = await setup.query(
        `select telegram_user_id::text as telegram_user_id
           from public.telegram_users where id = $1`,
        [bigUserRowId]
      );
      expect(stored[0].telegram_user_id).toBe(bigTelegramUserId);
    } finally {
      await setup.query(`delete from public.appointments where telegram_user_id = $1`, [
        bigUserRowId,
      ]);
      await setup.query(`delete from public.telegram_users where id = $1`, [bigUserRowId]);
    }
  });
});
