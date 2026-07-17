-- Этап 4. Пересекающиеся активные интервалы working_hours одного дня
-- недели должны быть невозможны на уровне PostgreSQL, а не только в форме
-- админ-панели (иначе get_available_slots молча дедуплицирует пересечение
-- через DISTINCT — см. 20260716130100_booking_functions.sql — что скрывает
-- саму ошибку конфигурации, а не предотвращает её).
--
-- Диагностика (тот же запрос, что и в проверке ниже) — выполните вручную
-- на production ДО применения этой миграции, если хотите заранее увидеть
-- конфликтующие пары строк:
--
--   select a.id as first_id, b.id as second_id, a.weekday,
--          a.start_time as first_start, a.end_time as first_end,
--          b.start_time as second_start, b.end_time as second_end
--     from public.working_hours a
--     join public.working_hours b
--       on a.weekday = b.weekday and a.id < b.id
--    where a.is_active and b.is_active
--      and (a.start_time, a.end_time) overlaps (b.start_time, b.end_time);
--
-- Миграция НЕ удаляет и не исправляет существующие строки автоматически.
-- Если конфликт есть, блок ниже падает с понятной ошибкой и точным списком
-- пар id — исправьте вручную (деактивируйте один из интервалов в каждой
-- паре или измените его границы через public.working_hours), затем
-- примените миграцию заново.

do $$
declare
  v_conflict record;
  v_conflicts text := '';
  v_has_conflicts boolean := false;
begin
  for v_conflict in
    select a.id as first_id, b.id as second_id, a.weekday,
           a.start_time as first_start, a.end_time as first_end,
           b.start_time as second_start, b.end_time as second_end
      from public.working_hours a
      join public.working_hours b
        on a.weekday = b.weekday and a.id < b.id
     where a.is_active and b.is_active
       and (a.start_time, a.end_time) overlaps (b.start_time, b.end_time)
  loop
    v_has_conflicts := true;
    v_conflicts := v_conflicts || format(
      E'\n  - weekday=%s: %s (%s-%s) пересекается с %s (%s-%s)',
      v_conflict.weekday,
      v_conflict.first_id, v_conflict.first_start, v_conflict.first_end,
      v_conflict.second_id, v_conflict.second_start, v_conflict.second_end
    );
  end loop;

  if v_has_conflicts then
    raise exception
      E'Миграция working_hours_no_overlap_active прервана: в public.working_hours уже есть пересекающиеся активные интервалы:%\nИсправьте вручную (деактивируйте один из интервалов в каждой паре через is_active = false, либо измените его start_time/end_time), затем примените миграцию заново. Автоматическое исправление намеренно не выполняется.',
      v_conflicts;
  end if;
end;
$$;

-- weekday с "=" в exclusion constraint требует btree_gist (установлен в
-- 20260716100000_extensions_and_helpers.sql для appointments).
alter table public.working_hours
  add constraint working_hours_no_overlap_active
  exclude using gist (
    weekday with =,
    tsrange(
      ('2000-01-01'::date + start_time)::timestamp,
      ('2000-01-01'::date + end_time)::timestamp,
      '[)'
    ) with &&
  ) where (is_active);
