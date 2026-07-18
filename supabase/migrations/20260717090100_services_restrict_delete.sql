-- Этап 4. Панель администратора не должна иметь возможности физически
-- удалить услугу: appointments.service_id ссылается на неё (история
-- записей должна сохраняться), а в UI есть только "активировать" /
-- "деактивировать" (обновление is_active), не удаление. Остальные права
-- authenticated на services (select/insert/update), выданные в
-- 20260716100400_services.sql, не меняются.

revoke delete on table public.services from authenticated;
