import { z } from "zod";
import { isValidIanaTimeZone } from "./date-time";

/**
 * Zod-схемы форм административной панели. Границы значений здесь
 * дублируют CHECK-ограничения БД (см. supabase/migrations) намеренно —
 * это быстрая обратная связь пользователю до похода на сервер, а не
 * замена серверной/БД-проверки, которая остаётся последним словом.
 */

const HHMM_REGEX = /^([01]\d|2[0-3]):([0-5]\d)$/;
const timeSchema = z
  .string()
  .regex(HHMM_REGEX, "Время должно быть в формате ЧЧ:ММ");

// price_cents — integer в БД; ограничиваем сверху с запасом, чтобы
// rublesToCents() не могло переполнить 32-битный integer Postgres
// (2^31 - 1 копеек ≈ 21.4 млн рублей).
const MAX_PRICE_RUBLES = 1_000_000;

export const serviceFormSchema = z.object({
  name: z.string().trim().min(1, "Название обязательно").max(200),
  description: z.string().trim().max(2000).optional(),
  durationMinutes: z.coerce
    .number()
    .int("Продолжительность должна быть целым числом минут")
    .min(5, "Минимум 5 минут")
    .max(480, "Максимум 480 минут"),
  // Рубли, а не копейки — конвертация в price_cents происходит на сервере
  // (см. rublesToCents ниже), чтобы форма не оперировала копейками.
  priceRubles: z.coerce
    .number()
    .min(0, "Цена не может быть отрицательной")
    .max(MAX_PRICE_RUBLES, `Слишком большая цена (максимум ${MAX_PRICE_RUBLES})`)
    .refine(
      // Сравнение с допуском на погрешность плавающей точки: 19.99 * 100
      // в IEEE 754 double даёт 1998.9999999999998, а не ровно 1999 —
      // точное сравнение с Math.round() ложно отклонило бы валидное
      // значение.
      (value) => Number.isFinite(value) && Math.abs(value * 100 - Math.round(value * 100)) < 1e-6,
      "Цена не может содержать больше двух знаков после запятой"
    ),
  sortOrder: z.coerce.number().int(),
  isActive: z.boolean(),
});
export type ServiceFormInput = z.infer<typeof serviceFormSchema>;

/** Рубли (форма) -> цельные копейки (БД). Math.round убирает риск ошибок
 * плавающей точки (19.9 * 100 может дать 1989.9999999998 и т.п.). */
export function rublesToCents(rubles: number): number {
  return Math.round(rubles * 100);
}

export function centsToRubles(cents: number): number {
  return cents / 100;
}

export const workingHourFormSchema = z
  .object({
    weekday: z.coerce.number().int().min(0, "0 = понедельник").max(6, "6 = воскресенье"),
    startTime: timeSchema,
    endTime: timeSchema,
    isActive: z.boolean(),
  })
  .refine((value) => value.endTime > value.startTime, {
    message: "Время окончания должно быть позже времени начала",
    path: ["endTime"],
  });
export type WorkingHourFormInput = z.infer<typeof workingHourFormSchema>;

export const scheduleBlockFormSchema = z
  .object({
    localDate: z.iso.date("Некорректная дата"),
    startTime: timeSchema,
    endTime: timeSchema,
    reason: z.string().trim().max(500).optional(),
  })
  .refine((value) => value.endTime > value.startTime, {
    message: "Время окончания должно быть позже времени начала",
    path: ["endTime"],
  });
export type ScheduleBlockFormInput = z.infer<typeof scheduleBlockFormSchema>;

export const businessSettingsFormSchema = z.object({
  businessName: z.string().trim().min(1, "Название организации обязательно").max(200),
  timezone: z
    .string()
    .min(1, "Часовой пояс обязателен")
    .refine(isValidIanaTimeZone, "Не распознан как IANA-идентификатор часового пояса"),
  bookingHorizonDays: z.coerce.number().int().min(1).max(180),
  minBookingNoticeMinutes: z.coerce.number().int().min(0),
  cancellationNoticeMinutes: z.coerce.number().int().min(0),
  slotStepMinutes: z.coerce.number().int().min(5).max(120),
  reminderFirstMinutes: z.coerce.number().int().min(0).nullable(),
  reminderSecondMinutes: z.coerce.number().int().min(0).nullable(),
  // Обязательное дополнительное подтверждение при смене timezone (п. 13
  // ТЗ) — форма требует явного чекбокса, если значение отличается от
  // текущего сохранённого; сервер перепроверяет это же условие.
  confirmTimezoneChange: z.boolean().optional(),
});
export type BusinessSettingsFormInput = z.infer<typeof businessSettingsFormSchema>;

export const appointmentStatusChangeSchema = z.object({
  appointmentId: z.uuid(),
  newStatus: z.enum(["completed", "cancelled", "no_show"]),
  reason: z.string().trim().max(1000).optional(),
});
export type AppointmentStatusChangeInput = z.infer<typeof appointmentStatusChangeSchema>;

export const appointmentFilterSchema = z.object({
  dateFrom: z.iso.date().optional(),
  dateTo: z.iso.date().optional(),
  status: z.enum(["confirmed", "completed", "cancelled", "no_show"]).optional(),
  clientName: z.string().trim().max(200).optional(),
  telegramUsername: z.string().trim().max(200).optional(),
  telegramId: z.string().trim().regex(/^\d+$/, "Только цифры").optional(),
  page: z.coerce.number().int().min(1).default(1),
});
export type AppointmentFilterInput = z.infer<typeof appointmentFilterSchema>;
