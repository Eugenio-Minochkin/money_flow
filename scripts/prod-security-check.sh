#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/money-flow}"
cd "$APP_DIR"

set -a
. ./.env.production
set +a

health="$(curl -fsS http://127.0.0.1:3000/health)"
echo "$health" | grep -q '"ok":true'
echo "$health" | grep -q '"db":true'

direct_code="$(curl -sS -o /tmp/money-flow-direct-dashboard.out -w '%{http_code}' 'http://127.0.0.1:3000/api/dashboard?telegramUserId=100001')"
test "$direct_code" = "400"

webhook_code="$(curl -sS -o /tmp/money-flow-webhook-no-secret.out -w '%{http_code}' \
  -X POST http://127.0.0.1:3000/telegram/webhook \
  -H 'content-type: application/json' \
  -d '{}')"
test "$webhook_code" = "401"

if ss -lntp | grep -E '0\.0\.0\.0:5432|\[::\]:5432' >/dev/null; then
  echo "Postgres is exposed on a public interface" >&2
  exit 1
fi

latest_backup="$(find /opt/money-flow/backups -name 'money-flow-*.sql.gz' -type f -mtime -2 -print -quit)"
test -n "$latest_backup"
gzip -t "$latest_backup"

echo "security-check ok"
