#!/usr/bin/env bash
set -euo pipefail

# Прогоняет SQL/pgTAP-тесты (GRANT, RLS, SECURITY DEFINER, exclusion
# constraint) на чистой локальной базе PostgreSQL. Требует установленных
# psql/createdb/dropdb, pg_prove и расширения pgtap (пакет
# postgresql-*-pgtap или эквивалент).
#
# Параметры подключения берутся из стандартных переменных окружения
# libpq (PGHOST, PGPORT, PGUSER, PGPASSWORD) — по умолчанию локальный
# сокет текущего пользователя. Имя тестовой базы можно переопределить
# через TEST_SQL_DATABASE; по умолчанию используется bookingbot_test —
# та же база, которую ожидает tests/integration/double-booking-race.test.ts
# через TEST_DATABASE_URL.

db_name="${TEST_SQL_DATABASE:-bookingbot_test}"

echo "==> Пересоздаю тестовую базу ${db_name}"
dropdb --if-exists "$db_name"
createdb "$db_name"

echo "==> Применяю local_bootstrap.sql (роли + заглушка auth — только для локальных тестов)"
psql -v ON_ERROR_STOP=1 -d "$db_name" -f scripts/sql/local_bootstrap.sql

echo "==> Применяю миграции"
for f in supabase/migrations/*.sql; do
  echo "    - $f"
  psql -v ON_ERROR_STOP=1 -d "$db_name" -f "$f"
done

echo "==> Применяю seed.sql"
psql -v ON_ERROR_STOP=1 -d "$db_name" -f supabase/seed.sql

echo "==> Устанавливаю расширение pgtap"
psql -v ON_ERROR_STOP=1 -d "$db_name" -c "create extension if not exists pgtap;"

echo "==> Запускаю pgTAP-тесты"
pg_prove -d "$db_name" supabase/tests/*.test.sql
