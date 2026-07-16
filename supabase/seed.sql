-- Стартовые данные, обязательные для работы приложения.
--
-- business_settings — синглтон-строка (id = 1), без неё бот и админ-панель
-- не смогут прочитать часовой пояс и остальные настройки организации.
-- Значения по умолчанию соответствуют разделу 7.1 технического задания;
-- администратор может изменить их позже через /admin/settings.
--
-- Услуги, расписание и блокировки намеренно не заполняются здесь: это
-- реальные бизнес-данные, которые должен ввести администратор через
-- панель, а не тестовые данные, случайно оставшиеся в проекте.

insert into public.business_settings (
  id,
  business_name,
  timezone,
  booking_horizon_days,
  min_booking_notice_minutes,
  cancellation_notice_minutes,
  reminder_first_minutes,
  reminder_second_minutes,
  slot_step_minutes
) values (
  1,
  'BookingBot',
  'Europe/Moscow',
  14,
  120,
  120,
  1440,
  120,
  15
)
on conflict (id) do nothing;
