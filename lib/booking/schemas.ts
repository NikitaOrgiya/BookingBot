import { z } from "zod";

/**
 * Zod-схемы входных данных ядра бронирования. Валидация выполняется на
 * серверной границе до обращения к базе: некорректный вход отсекается
 * предсказуемой ошибкой валидации, а не сырой ошибкой PostgreSQL.
 */

/**
 * Внешний Telegram-идентификатор клиента — строка, а не JavaScript number.
 * В БД это bigint (полная 64-битная точность); Telegram ID теоретически
 * может превысить Number.MAX_SAFE_INTEGER (2^53-1), после чего JS number
 * молча теряет точность (без исключения). Строка проходит через весь
 * TypeScript-слой и до RPC-вызова включительно без единого Number()/
 * parseInt() — терять точность негде (см. lib/booking/reserve-appointment.ts,
 * lib/booking/cancel-appointment.ts). Регулярное выражение допускает только
 * положительное десятичное целое без знака, ведущих нулей и дробной части.
 */
const telegramUserIdSchema = z
  .string({ message: "telegramUserId обязателен и должен быть строкой" })
  .regex(
    /^[1-9][0-9]*$/,
    "telegramUserId должен быть положительным десятичным целым без знака и дробной части (строкой)"
  );

export const getAvailableSlotsInputSchema = z.object({
  serviceId: z.uuid(),
  // Локальные даты бизнеса в формате YYYY-MM-DD (границы окна выборки).
  fromDate: z.iso.date().optional(),
  toDate: z.iso.date().optional(),
});

export const reserveAppointmentInputSchema = z.object({
  telegramUserId: telegramUserIdSchema,
  serviceId: z.uuid(),
  // Начало приёма в ISO-8601 со смещением/таймзоной (timestamptz).
  startAt: z.iso.datetime({ offset: true }),
  clientNote: z.string().max(1000).optional(),
});

export const cancelAppointmentInputSchema = z.object({
  appointmentId: z.uuid(),
  telegramUserId: telegramUserIdSchema,
  reason: z.string().max(1000).optional(),
});

export type GetAvailableSlotsInput = z.infer<typeof getAvailableSlotsInputSchema>;
export type ReserveAppointmentInput = z.infer<
  typeof reserveAppointmentInputSchema
>;
export type CancelAppointmentInput = z.infer<
  typeof cancelAppointmentInputSchema
>;
