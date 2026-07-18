import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Интеграционные тесты административных объектов Этапа 4 через реальный
 * PostgreSQL (пакет pg): admin_change_appointment_status,
 * admin_create_schedule_block, деактивация услуги, влияние изменения
 * расписания/блокировок на get_available_slots.
 *
 * Как и tests/integration/booking-functions.test.ts, требует
 * TEST_DATABASE_URL (та же bookingbot_test, что готовит `npm run
 * test:sql`). Без переменной тест пропускается, а не падает и не
 * подделывает результат.
 *
 * "Вход администратора"/"отказ неадминистратору" здесь проверяются на
 * уровне БД (is_admin() под ролью authenticated с разным
 * request.jwt.claim.sub) — реальный HTTP-логин через Supabase Auth
 * (GoTrue) не воспроизводим без запущенного Supabase-проекта, которого
 * нет в этой тестовой среде. "Telegram-бронирование продолжает работать
 * после всех миграций Этапа 4" подтверждается тем, что все существующие
 * файлы tests/integration/*.test.ts (не изменённые в этом файле) проходят
 * без изменений против той же схемы — см. полный прогон `npm run
 * test:integration`.
 *
 * npm run test:integration
 */

const connectionString = process.env.TEST_DATABASE_URL;

function isoDatePlusDays(days: number): string {
  const base = new Date();
  base.setUTCDate(base.getUTCDate() + days);
  return base.toISOString().slice(0, 10);
}

describe.skipIf(!connectionString)("административные функции Этапа 4", () => {
  let setup: Client; // суперпользовательское подключение для setup/cleanup
  let adminConn: Client; // authenticated + jwt claim администратора
  let nonAdminConn: Client; // authenticated + jwt claim не-администратора

  const adminUserId = randomUUID();
  const nonAdminUserId = randomUUID();
  const telegramUserId = `7${Date.now()}`;
  const userRowId = randomUUID();
  const serviceId = randomUUID();
  const otherServiceId = randomUUID();
  const workingHoursIds: string[] = [];
  const appointmentIds: string[] = [];

  let savedSettings: {
    timezone: string;
    booking_horizon_days: number;
    min_booking_notice_minutes: number;
  };
  let day15WorkingHoursId: string;

  beforeAll(async () => {
    setup = new Client({ connectionString });
    await setup.connect();

    const { rows: settingsRows } = await setup.query(
      `select timezone, booking_horizon_days, min_booking_notice_minutes
         from public.business_settings where id = 1`
    );
    savedSettings = settingsRows[0];
    // booking_horizon_days по умолчанию (seed.sql) — 14 дней, а этот файл
    // использует даты вплоть до +16 — расширяем горизонт, как и
    // tests/integration/booking-functions.test.ts (90, а не 365:
    // CHECK business_settings_horizon_range ограничивает 1..180).
    await setup.query(
      `update public.business_settings
          set timezone = 'Europe/Moscow', booking_horizon_days = 90,
              min_booking_notice_minutes = 0
        where id = 1`
    );

    await setup.query(`insert into auth.users (id) values ($1), ($2)`, [
      adminUserId,
      nonAdminUserId,
    ]);
    await setup.query(`insert into public.admin_users (user_id) values ($1)`, [
      adminUserId,
    ]);
    await setup.query(
      `insert into public.telegram_users (id, telegram_user_id) values ($1, $2)`,
      [userRowId, telegramUserId]
    );
    await setup.query(
      `insert into public.services (id, name, duration_minutes, price_cents, is_active)
       values ($1, 'Интеграционная услуга Этапа 4', 60, 150000, true),
              ($2, 'Другая активная услуга Этапа 4', 30, 100000, true)`,
      [serviceId, otherServiceId]
    );
    // Рабочие часы на все дни недели 08:00-20:00 — чтобы даты reserve_appointment
    // (+12..+14) заведомо попадали в расписание независимо от дня недели
    // (тот же приём, что и в tests/integration/booking-functions.test.ts).
    for (let weekday = 0; weekday <= 6; weekday += 1) {
      const id = randomUUID();
      workingHoursIds.push(id);
      await setup.query(
        `insert into public.working_hours (id, weekday, start_time, end_time, is_active)
         values ($1, $2, '08:00', '20:00', true)`,
        [id, weekday]
      );
    }
    const { rows: day15Row } = await setup.query(
      `select extract(isodow from (now() at time zone 'Europe/Moscow')::date + 15)::int - 1 as wd`
    );
    day15WorkingHoursId = workingHoursIds[day15Row[0].wd];

    adminConn = new Client({ connectionString });
    await adminConn.connect();
    await adminConn.query("set role authenticated");
    // SET не поддерживает параметризованные значения — set_config() их
    // принимает и делает то же самое (session-level, is_local = false).
    await adminConn.query("select set_config('request.jwt.claim.sub', $1, false)", [
      adminUserId,
    ]);

    nonAdminConn = new Client({ connectionString });
    await nonAdminConn.connect();
    await nonAdminConn.query("set role authenticated");
    await nonAdminConn.query("select set_config('request.jwt.claim.sub', $1, false)", [
      nonAdminUserId,
    ]);
  });

  afterAll(async () => {
    await setup.query(`delete from public.appointments where id = any($1)`, [
      appointmentIds,
    ]);
    await setup.query(`delete from public.working_hours where id = any($1)`, [
      workingHoursIds,
    ]);
    await setup.query(`delete from public.services where id in ($1, $2)`, [
      serviceId,
      otherServiceId,
    ]);
    await setup.query(`delete from public.telegram_users where id = $1`, [userRowId]);
    await setup.query(`delete from public.admin_users where user_id = $1`, [adminUserId]);
    await setup.query(`delete from auth.users where id in ($1, $2)`, [
      adminUserId,
      nonAdminUserId,
    ]);
    await setup.query(
      `update public.business_settings
          set timezone = $1, booking_horizon_days = $2, min_booking_notice_minutes = $3
        where id = 1`,
      [
        savedSettings.timezone,
        savedSettings.booking_horizon_days,
        savedSettings.min_booking_notice_minutes,
      ]
    );

    await adminConn?.end();
    await nonAdminConn?.end();
    await setup?.end();
  });

  it("is_admin(): true для администратора, false для обычного пользователя", async () => {
    const admin = await adminConn.query("select public.is_admin() as v");
    expect(admin.rows[0].v).toBe(true);

    const nonAdmin = await nonAdminConn.query("select public.is_admin() as v");
    expect(nonAdmin.rows[0].v).toBe(false);
  });

  it("admin_change_appointment_status: администратор меняет статус, изменение сохраняется", async () => {
    const svc = new Client({ connectionString });
    await svc.connect();
    await svc.query("set role service_role");

    const { rows } = await svc.query(
      `select id from public.reserve_appointment($1, $2, $3, $4)`,
      [telegramUserId, serviceId, `${isoDatePlusDays(12)}T12:00:00+03:00`, null]
    );
    const appointmentId = rows[0].id;
    appointmentIds.push(appointmentId);
    await svc.end();

    const { rows: changed } = await adminConn.query(
      `select * from public.admin_change_appointment_status($1, $2, $3)`,
      [appointmentId, "completed", null]
    );
    expect(changed[0].status).toBe("completed");

    // Сохранилось по-настоящему — перечитываем в отдельном запросе.
    const { rows: reread } = await adminConn.query(
      `select status from public.appointments where id = $1`,
      [appointmentId]
    );
    expect(reread[0].status).toBe("completed");
  });

  it("admin_change_appointment_status: обычный authenticated получает NOT_ADMIN (42501)", async () => {
    const svc = new Client({ connectionString });
    await svc.connect();
    await svc.query("set role service_role");
    const { rows } = await svc.query(
      `select id from public.reserve_appointment($1, $2, $3, $4)`,
      [telegramUserId, serviceId, `${isoDatePlusDays(13)}T12:00:00+03:00`, null]
    );
    const appointmentId = rows[0].id;
    appointmentIds.push(appointmentId);
    await svc.end();

    await expect(
      nonAdminConn.query(
        `select * from public.admin_change_appointment_status($1, $2, $3)`,
        [appointmentId, "completed", null]
      )
    ).rejects.toMatchObject({ code: "42501" });
  });

  it("admin_change_appointment_status: недопустимый переход отклоняется (PB014)", async () => {
    const svc = new Client({ connectionString });
    await svc.connect();
    await svc.query("set role service_role");
    const { rows } = await svc.query(
      `select id from public.reserve_appointment($1, $2, $3, $4)`,
      [telegramUserId, serviceId, `${isoDatePlusDays(14)}T12:00:00+03:00`, null]
    );
    const appointmentId = rows[0].id;
    appointmentIds.push(appointmentId);
    await svc.end();

    await adminConn.query(
      `select * from public.admin_change_appointment_status($1, $2, $3)`,
      [appointmentId, "cancelled", null]
    );

    await expect(
      adminConn.query(
        `select * from public.admin_change_appointment_status($1, $2, $3)`,
        [appointmentId, "completed", null]
      )
    ).rejects.toMatchObject({ code: "PB014" });
  });

  it("услуги: authenticated может создать/изменить, но не удалить физически", async () => {
    const created = await adminConn.query(
      `insert into public.services (name, duration_minutes, price_cents, is_active, sort_order)
       values ('Новая услуга интеграционного теста', 45, 90000, true, 999)
       returning id`
    );
    const newServiceId = created.rows[0].id;

    await adminConn.query(`update public.services set price_cents = 95000 where id = $1`, [
      newServiceId,
    ]);
    const { rows: afterUpdate } = await adminConn.query(
      `select price_cents from public.services where id = $1`,
      [newServiceId]
    );
    expect(afterUpdate[0].price_cents).toBe(95000);

    await expect(
      adminConn.query(`delete from public.services where id = $1`, [newServiceId])
    ).rejects.toMatchObject({ code: "42501" });

    // Уборка через service_role (единственный практический способ убрать
    // строку теста — DELETE физически всё ещё возможен на уровне таблицы
    // для роли, которая явно имеет на это право; authenticated его не
    // имеет намеренно, что и проверяет тест выше).
    await setup.query(`delete from public.services where id = $1`, [newServiceId]);
  });

  it("деактивация услуги: is_active=false скрывает её из выборки активных услуг", async () => {
    await adminConn.query(`update public.services set is_active = false where id = $1`, [
      otherServiceId,
    ]);

    // Тот же запрос (is_active + order by sort_order, name), которым
    // lib/telegram/repositories/services.ts:listActiveServices() отбирает
    // услуги для бота, выполненный под service_role (роль, которой
    // реально пользуется бот).
    const svc = new Client({ connectionString });
    await svc.connect();
    await svc.query("set role service_role");
    const { rows } = await svc.query(
      `select id from public.services where is_active = true order by sort_order, name`
    );
    await svc.end();

    expect(rows.map((r) => r.id)).not.toContain(otherServiceId);

    await adminConn.query(`update public.services set is_active = true where id = $1`, [
      otherServiceId,
    ]);
  });

  it("изменение расписания сразу меняет доступные слоты get_available_slots", async () => {
    const targetDate = new Date();
    targetDate.setUTCDate(targetDate.getUTCDate() + 15);
    const dateString = targetDate.toISOString().slice(0, 10);

    const svc = new Client({ connectionString });
    await svc.connect();
    await svc.query("set role service_role");

    const before = await svc.query(
      `select count(*)::int as c from public.get_available_slots($1, $2, $2)`,
      [serviceId, dateString]
    );
    expect(before.rows[0].c).toBeGreaterThan(0);

    // Администратор деактивирует рабочий интервал именно этого дня недели
    // (+15), остальные 6 дней остаются нетронутыми.
    await adminConn.query(`update public.working_hours set is_active = false where id = $1`, [
      day15WorkingHoursId,
    ]);

    const after = await svc.query(
      `select count(*)::int as c from public.get_available_slots($1, $2, $2)`,
      [serviceId, dateString]
    );
    expect(after.rows[0].c).toBe(0);

    await adminConn.query(`update public.working_hours set is_active = true where id = $1`, [
      day15WorkingHoursId,
    ]);
    await svc.end();
  });

  it("разовая блокировка (admin_create_schedule_block) убирает слот из get_available_slots", async () => {
    // Тот же день (+15), что и в предыдущем тесте — его рабочий интервал
    // снова активен (реактивирован в конце предыдущего теста).
    const targetDate = new Date();
    targetDate.setUTCDate(targetDate.getUTCDate() + 15);
    const dateString = targetDate.toISOString().slice(0, 10);

    const svc = new Client({ connectionString });
    await svc.connect();
    await svc.query("set role service_role");

    const before = await svc.query(
      `select slot_start from public.get_available_slots($1, $2, $2) order by slot_start limit 1`,
      [serviceId, dateString]
    );
    expect(before.rows.length).toBeGreaterThan(0);

    const { rows: blockRows } = await adminConn.query(
      `select id from public.admin_create_schedule_block($1, '00:00', '23:59', $2)`,
      [dateString, "интеграционный тест: весь день"]
    );
    const blockId = blockRows[0].id;

    const after = await svc.query(
      `select count(*)::int as c from public.get_available_slots($1, $2, $2)`,
      [serviceId, dateString]
    );
    expect(after.rows[0].c).toBe(0);

    await setup.query(`delete from public.schedule_blocks where id = $1`, [blockId]);
    await svc.end();
  });

  it("admin_update_schedule_block/admin_delete_schedule_block: будущая блокировка изменяется и удаляется", async () => {
    const dateString = isoDatePlusDays(20);

    const { rows: created } = await adminConn.query(
      `select id, reason from public.admin_create_schedule_block($1, '10:00', '12:00', $2)`,
      [dateString, "future block for update/delete test"]
    );
    const blockId = created[0].id;

    const { rows: updated } = await adminConn.query(
      `select reason from public.admin_update_schedule_block($1, $2, '11:00', '13:00', $3)`,
      [blockId, dateString, "updated future block"]
    );
    expect(updated[0].reason).toBe("updated future block");

    await adminConn.query(`select public.admin_delete_schedule_block($1)`, [blockId]);
    const { rows: afterDelete } = await setup.query(
      `select count(*)::int as c from public.schedule_blocks where id = $1`,
      [blockId]
    );
    expect(afterDelete[0].c).toBe(0);
  });

  it("прошедшую блокировку нельзя ни изменить, ни удалить (PAST_SCHEDULE_BLOCK_IMMUTABLE)", async () => {
    const { rows: pastBlockRows } = await setup.query(
      `insert into public.schedule_blocks (starts_at, ends_at, reason)
       values (now() - interval '2 days', now() - interval '2 days' + interval '1 hour', 'past block')
       returning id`
    );
    const pastBlockId = pastBlockRows[0].id;

    await expect(
      adminConn.query(
        `select public.admin_update_schedule_block($1, $2, '10:00', '11:00', null)`,
        [pastBlockId, isoDatePlusDays(1)]
      )
    ).rejects.toMatchObject({ code: "PB017" });

    await expect(
      adminConn.query(`select public.admin_delete_schedule_block($1)`, [pastBlockId])
    ).rejects.toMatchObject({ code: "PB017" });

    // Строка действительно осталась нетронутой.
    const { rows: stillThere } = await setup.query(
      `select count(*)::int as c from public.schedule_blocks where id = $1`,
      [pastBlockId]
    );
    expect(stillThere[0].c).toBe(1);

    await setup.query(`delete from public.schedule_blocks where id = $1`, [pastBlockId]);
  });

  it("обычный authenticated не может вызвать admin_update_schedule_block/admin_delete_schedule_block (NOT_ADMIN)", async () => {
    const { rows: created } = await adminConn.query(
      `select id from public.admin_create_schedule_block($1, '10:00', '12:00', null)`,
      [isoDatePlusDays(21)]
    );
    const blockId = created[0].id;

    await expect(
      nonAdminConn.query(
        `select public.admin_update_schedule_block($1, $2, '10:00', '11:00', null)`,
        [blockId, isoDatePlusDays(21)]
      )
    ).rejects.toMatchObject({ code: "42501" });

    await expect(
      nonAdminConn.query(`select public.admin_delete_schedule_block($1)`, [blockId])
    ).rejects.toMatchObject({ code: "42501" });

    await setup.query(`delete from public.schedule_blocks where id = $1`, [blockId]);
  });

  it("прямой DELETE на schedule_blocks запрещён даже администратору (только через RPC)", async () => {
    const { rows: created } = await adminConn.query(
      `select id from public.admin_create_schedule_block($1, '10:00', '12:00', null)`,
      [isoDatePlusDays(22)]
    );
    const blockId = created[0].id;

    await expect(
      adminConn.query(`delete from public.schedule_blocks where id = $1`, [blockId])
    ).rejects.toMatchObject({ code: "42501" });

    await adminConn.query(`select public.admin_delete_schedule_block($1)`, [blockId]);
  });
});
