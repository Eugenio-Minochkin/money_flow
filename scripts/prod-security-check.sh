#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/money-flow}"
cd "$APP_DIR"

set -a
. ./.env.production
set +a

if [ "${REQUIRE_TELEGRAM_INIT_DATA:-}" != "true" ]; then
  echo "REQUIRE_TELEGRAM_INIT_DATA must be true" >&2
  exit 1
fi

if [ -z "${TELEGRAM_WEBHOOK_SECRET:-}" ]; then
  echo "TELEGRAM_WEBHOOK_SECRET must be non-empty" >&2
  exit 1
fi

health=""
for attempt in {1..30}; do
  echo "Waiting for API health... attempt $attempt/30"
  if health="$(curl -fsS http://127.0.0.1:3000/health 2>/dev/null)" \
    && echo "$health" | grep -q '"ok":true' \
    && echo "$health" | grep -q '"db":true'; then
    break
  fi

  if [ "$attempt" = "30" ]; then
    echo "API health check failed after 60 seconds" >&2
    exit 1
  fi

  sleep 2
done

direct_code="$(curl -sS -o /tmp/money-flow-direct-dashboard.out -w '%{http_code}' 'http://127.0.0.1:3000/api/dashboard?telegramUserId=100001')"
test "$direct_code" = "400"
grep -q '"telegram_init_data_required"' /tmp/money-flow-direct-dashboard.out

webhook_code="$(curl -sS -o /tmp/money-flow-webhook-no-secret.out -w '%{http_code}' \
  -X POST http://127.0.0.1:3000/telegram/webhook \
  -H 'content-type: application/json' \
  -d '{}')"
test "$webhook_code" = "401"
grep -q '"invalid_webhook_secret"' /tmp/money-flow-webhook-no-secret.out

if ss -lntp | grep -E '0\.0\.0\.0:5432|\[::\]:5432' >/dev/null; then
  echo "Postgres is exposed on a public interface" >&2
  exit 1
fi

backup_root="${BACKUP_DIR:-/opt/money-flow/backups/postgres}"
latest_backup="$(find "$backup_root" -maxdepth 1 -name 'moneyflow-postgres-*.dump' -type f -mtime -2 -print -quit)"
if [ -z "$latest_backup" ]; then
  echo "No Postgres backup newer than 2 days in $backup_root" >&2
  exit 1
fi

# Validate the dump is a readable pg_restore custom-format archive. The file
# lives on the host, so copy it into the postgres container (custom format
# requires a seekable file) and list its contents with pg_restore.
seccheck_tmp="/tmp/money-flow-seccheck-backup.dump"
docker compose --env-file .env.production -f compose.prod.yml cp "$latest_backup" "postgres:${seccheck_tmp}"
seccheck_ok=0
# MSYS_NO_PATHCONV stops Git Bash on Windows from rewriting the container path.
if MSYS_NO_PATHCONV=1 docker compose --env-file .env.production -f compose.prod.yml exec -T postgres \
  pg_restore --list "$seccheck_tmp" >/dev/null 2>&1; then
  seccheck_ok=1
fi
MSYS_NO_PATHCONV=1 docker compose --env-file .env.production -f compose.prod.yml exec -T postgres \
  rm -f "$seccheck_tmp" >/dev/null 2>&1 || true
if [ "$seccheck_ok" -ne 1 ]; then
  echo "Latest backup is not a valid pg_restore archive: $latest_backup" >&2
  exit 1
fi

echo "security-check ok"
