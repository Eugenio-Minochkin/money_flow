# Money Flow Security Runbook

## Production Layout

- App directory: `/opt/money-flow`
- Runtime env: `/opt/money-flow/.env.production`
- Postgres backups: `/opt/money-flow/backups`
- Backup script: `/opt/money-flow/backup-postgres.sh`
- Backup cron: `/etc/cron.d/money-flow-backup`
- SSH hardening: `/etc/ssh/sshd_config.d/99-money-flow-hardening.conf`

Do not print `.env.production` in shared logs. Use targeted `grep '^KEY='` only for non-secret flags.

## Rotate Secrets

1. Rotate the provider key in its console:
   - Telegram BotFather: bot token
   - OpenAI: project API key
   - Deepgram: API key
2. SSH into the server:

```bash
ssh -i ~/.ssh/money_flow_deploy root@194.233.78.171
```

3. Edit `/opt/money-flow/.env.production` and replace the relevant values:

```bash
nano /opt/money-flow/.env.production
chmod 600 /opt/money-flow/.env.production
```

Production must keep `TELEGRAM_WEBHOOK_SECRET` non-empty and `REQUIRE_TELEGRAM_INIT_DATA=true`.

4. If the Telegram token or webhook secret changed, reset the webhook:

```bash
cd /opt/money-flow
set -a
. ./.env.production
set +a
curl -fsS -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setWebhook" \
  -d "url=https://${APP_DOMAIN}/telegram/webhook" \
  -d "secret_token=${TELEGRAM_WEBHOOK_SECRET}"
```

5. Restart the API:

```bash
cd /opt/money-flow
docker compose --env-file .env.production -f compose.prod.yml up -d api
curl -fsS http://127.0.0.1:3000/health
```

## Backup

Backups run daily at `02:15` server time and keep files for 14 days.

Create a manual backup:

```bash
/opt/money-flow/backup-postgres.sh
ls -lh /opt/money-flow/backups | tail
```

Check backup archive integrity:

```bash
gzip -t /opt/money-flow/backups/money-flow-YYYYMMDDTHHMMSSZ.sql.gz
```

## Restore Drill

Use this to verify a backup without touching the production database.

```bash
cd /opt/money-flow
set -a
. ./.env.production
set +a
backup=/opt/money-flow/backups/money-flow-YYYYMMDDTHHMMSSZ.sql.gz
restore_db="money_flow_restore_check"

printf 'DROP DATABASE IF EXISTS %s;\n' "$restore_db" | docker compose --env-file .env.production -f compose.prod.yml exec -T postgres \
  psql -U "$POSTGRES_USER" -d postgres
printf 'CREATE DATABASE %s;\n' "$restore_db" | docker compose --env-file .env.production -f compose.prod.yml exec -T postgres \
  psql -U "$POSTGRES_USER" -d postgres
gzip -dc "$backup" | docker compose --env-file .env.production -f compose.prod.yml exec -T postgres \
  psql -U "$POSTGRES_USER" -d "$restore_db" >/tmp/money-flow-restore-check.log
printf 'SELECT COUNT(*) AS users FROM users;\n' | docker compose --env-file .env.production -f compose.prod.yml exec -T postgres \
  psql -U "$POSTGRES_USER" -d "$restore_db"
printf 'DROP DATABASE %s;\n' "$restore_db" | docker compose --env-file .env.production -f compose.prod.yml exec -T postgres \
  psql -U "$POSTGRES_USER" -d postgres
```

## Security Checks

```bash
cd /opt/money-flow
./scripts/prod-security-check.sh
```

Manual equivalent:

```bash
cd /opt/money-flow
curl -fsS http://127.0.0.1:3000/health
curl -sS -o /tmp/direct-dashboard.out -w '%{http_code}\n' \
  'http://127.0.0.1:3000/api/dashboard?telegramUserId=100001'
curl -sS -o /tmp/webhook-no-secret.out -w '%{http_code}\n' \
  -X POST http://127.0.0.1:3000/telegram/webhook \
  -H 'content-type: application/json' \
  -d '{}'
ss -lntp | grep -E ':(3000|5432) ' || true
```

Expected:

- `/health` returns `{"ok":true}`
- direct dashboard without Telegram `initData` returns `400` when `REQUIRE_TELEGRAM_INIT_DATA=true`
- webhook without Telegram secret returns `401`
- port `3000` is bound to `127.0.0.1`; Postgres is not exposed on the host
