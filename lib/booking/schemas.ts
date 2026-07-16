import { z } from "zod";

/**
 * Zod-схемы входных данных ядра бронирования. Валидация выполняется на
 * серверной границе до обращения к базе: некорректный вход отсекается
 * предсказуемой ошибкой валидации, а не сырой ошибкой PostgreSQL.
 */

export const getAvailableSlotsInputSchema = z.object({
  serviceId: z.uuid(),
  // Локальные даты бизнеса в формате YYYY-MM-DD (границы окна выборки).
  fromDate: z.iso.date().optional(),
  toDate: z.iso.date().optional(),
});

export const reserveAppointmentInputSchema = z.object({
  // Внешний Telegram-идентификатор (bigint в БД; в пределах Number.MAX_SAFE).
  telegramUserId: z.int().positive(),
  serviceId: z.uuid(),
  // Начало приёма в ISO-8601 со смещением/таймзоной (timestamptz).
  startAt: z.iso.datetime({ offset: true }),
  clientNote: z.string().max(1000).optional(),
});

export const cancelAppointmentInputSchema = z.object({
  appointmentId: z.uuid(),
  telegramUserId: z.int().positive(),
  reason: z.string().max(1000).optional(),
});

export type GetAvailableSlotsInput = z.infer<typeof getAvailableSlotsInputSchema>;
export type ReserveAppointmentInput = z.infer<
  typeof reserveAppointmentInputSchema
>;
export type CancelAppointmentInput = z.infer<
  typeof cancelAppointmentInputSchema
>;
