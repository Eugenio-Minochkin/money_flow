# Money Flow Deployment Runbook

This project deploys from GitHub Actions to the existing production server over SSH.

## Safe Change Flow

Agents and Codex must not push directly to `master` and must not trigger production deploys themselves. Use a branch and PR for every code or documentation change:

```bash
git fetch origin --prune
git switch master
git pull --ff-only origin master
git status -sb
```

If `git pull --ff-only origin master` fails or shows a diverged branch, stop and ask the user. Do not repair history, reset, stash, delete branches, or overwrite local files without explicit approval for that exact recovery action.

After the preflight succeeds, create a short-lived branch from the updated `master`:

```bash
git status
git checkout -b codex/<short-change-name>
npm test
git add <files>
git commit -m "Describe the change"
git push -u origin codex/<short-change-name>
gh pr create --base master --head codex/<short-change-name> --title "Describe the change" --body-file <pr-body.md>
```

After opening or updating the PR, send the user the PR link for review and stop. Do not merge the PR, push to `master`, run deployment, SSH into production, or run production commands unless the user explicitly asks for that exact action.

Production deploy happens only after an approved PR is merged into `master` and CI passes, or through an explicit manual `workflow_dispatch` rollback/deploy requested by the user.

Useful checks before opening the PR:

```bash
git log --oneline -n 10
git status
git diff
```

PR description checks:

- For admin alerts / Telegram observability PRs, include an example alert from
  a test or local run. Redact placeholder IDs and any secret-like values, then
  check that the message is not too long and does not expose sensitive data
  such as tokens, env values, `initData`, cookies, authorization headers, raw
  request bodies, or personal financial details.

## Expense Parser Rollout And Rollback

Parser rollout is an owner-operated production change. Merging parser code or
this runbook does not authorize production env edits, deploys, service restarts,
or rollout changes. `EXPENSE_PARSER_LLM_TIMEOUT_MS` defaults to `20000` only
when the variable is absent. An explicitly configured value must be a base-10
positive integer from 1 through 2147483647 milliseconds; any invalid value makes
startup fail fast with a safe configuration error that does not echo the value.

This timeout is a controlled runtime behavior change. LLM requests running
longer than the configured parser timeout are aborted even when the overall
Telegram job timeout is larger. An LLM timeout is not retried, and only a
`local_safe` result may be used as its fallback.

Advance one stage at a time, only after reviewing `/admin_stats_tech` for the
whole stage window:

| Stage | Minimum sample before advancing | Quality and latency gate |
| --- | ---: | --- |
| shadow | 100 shadow comparisons | zero unexplained critical disagreements; parser failure rate no worse than baseline; LLM HTTP and local parse P95 reviewed |
| owner/admin allowlist | 100 eligible messages | zero unsafe saves; no critical financial-field regression; local P95 below the LLM HTTP P95 |
| 10% | 100 local-primary messages | all prior gates remain green |
| 25% | 250 local-primary messages | all prior gates remain green |
| 50% | 500 local-primary messages | all prior gates remain green |
| 100% | 1,000 local-primary messages | all prior gates remain green through a full reporting window |

Stop conditions are any unsafe save, unexplained critical shadow disagreement,
material increase in parser failures, timeout errors above the accepted baseline,
or a local latency regression. Category-only disagreements are reviewed
separately and do not override a critical stop condition.

Rollback to shadow-only measurement means changing the environment to exactly:

```env
EXPENSE_PARSER_FAST_PATH_MODE=shadow
EXPENSE_PARSER_LOCAL_FIRST_ROLLOUT_PERCENT=0
EXPENSE_PARSER_LOCAL_FIRST_USER_IDS=
```

Then restart the services through the approved operator/deployment procedure so
the new environment is loaded. For full parser fast-path shutdown, set:

```env
EXPENSE_PARSER_FAST_PATH_MODE=off
```

Then restart the services again. These are operational instructions, not
authorization for an agent to edit production env, deploy, or restart anything.

## GitHub Secrets

Create these repository secrets in GitHub:

- `PROD_SSH_HOST`: server IP address or DNS name.
- `PROD_SSH_USER`: Linux user used for deployment.
- `PROD_SSH_KEY`: private SSH key for that user.

Optional:

- `PROD_SSH_PORT`: SSH port. Defaults to `22`.
- `PROD_APP_DIR`: production checkout directory. Defaults to `/opt/money-flow`.
- `PROD_SSH_KNOWN_HOSTS`: pinned SSH host key output. If omitted, the workflow uses `ssh-keyscan`.

Do not put Telegram, database, OpenAI, or Deepgram secrets in GitHub Actions. They stay on the server in `.env.production`.

## Rate Limit Proxy Settings

The API rate limiter trusts `X-Forwarded-For` only from `TRUSTED_PROXY_IPS`.
Current production publishes the API as `127.0.0.1:3000->3000/tcp` and the
host proxy forwards to `http://127.0.0.1:3000`. Inside the API container,
Docker bridge forwarding can appear as the compose network gateway, currently
`172.18.0.1`, so the default trusted proxy list includes `127.0.0.1`, `::1`,
and `172.18.0.1`.

If the host proxy moves into Docker, the compose network is recreated with a
different gateway, or traffic reaches the API from a different proxy address,
set `TRUSTED_PROXY_IPS` in `.env.production` to the exact proxy IPs. Do not
use broad private subnets unless the entire subnet is intentionally trusted.

`scripts/prod-security-check.sh` asserts this on every deploy. It resolves the
Docker network the `api` container is connected to, reads that network's
gateway (the `remoteAddress` the API sees for proxied requests), and fails the
security check with a clear message if the gateway is not present in
`TRUSTED_PROXY_IPS`. This catches a drifted bridge subnet before it silently
collapses unauthenticated requests into one shared rate-limit bucket. The check
is read-only (it inspects containers and networks; it never mutates production
state) and runs after `docker compose ... up -d` in the deploy workflow.

`RATE_LIMIT_MAX_REQUESTS` is the preferred limit variable. The production
compose file still falls back to legacy `RATE_LIMIT_MAX` when the new variable
is absent, so existing production env files keep their configured limit.

## Admin Alerts

Admin alerts are a cheap MVP observability channel for critical runtime errors.
They reuse the existing `TELEGRAM_BOT_TOKEN` sender and the existing
`ADMIN_TELEGRAM_IDS` allowlist. Do not create a second bot token for alerts.

Production alerts are off unless explicitly enabled:

```env
ADMIN_ALERTS_ENABLED=false
ADMIN_ALERT_THROTTLE_MS=600000
ADMIN_ALERT_MAX_MESSAGE_LENGTH=900
```

When enabling alerts, set `ADMIN_ALERTS_ENABLED=true` and keep
`ADMIN_TELEGRAM_IDS` limited to trusted admin Telegram IDs. The throttle value
limits repeated alerts with the same fingerprint so one failure loop does not
spam admins. The max message length keeps Telegram alerts compact; full stack
traces stay in Docker logs.

`scripts/backup-postgres.sh` also uses these alert settings for best-effort
backup failure alerts. When cron or a systemd timer passes `ENV_FILE`, the
script sources that file before checking alert settings, so
`ADMIN_ALERTS_ENABLED`, `TELEGRAM_BOT_TOKEN`, and `ADMIN_TELEGRAM_IDS` do not
need to be exported separately. The script must not print secrets; its Telegram
curl call keeps the bot-token URL in a temporary `0600` curl config file rather
than in the process command line.

To verify a change locally or in tests, trigger a controlled test error and put
the resulting sample alert in the PR description. Confirm that the sample is
short and does not include tokens, env values, `initData`, cookies,
authorization headers, raw request bodies, full stack traces, or personal
financial details.

## Automatic Release Digest

Every PR with user-visible changes includes this block:

```markdown
## User Release Notes

audience: user
version: v.1.19
category: history

RU:
- В истории расходов появился выбор периода.

EN:
- Expense history now has a period picker.
```

`version` is optional. If it is missing, malformed, stale, or already used,
the sync script assigns the next `v.1.x` version. Use `audience: admin` or
`audience: internal` for changes that must never reach normal users.

After production health and security checks, the workflow resolves the merged
PR associated with the deployed SHA and synchronizes its release block into
PostgreSQL. The API sends pending public notes at the configured local hour.
Release note synchronization is best-effort: if the release block is malformed
or GitHub lookup fails after the application is already healthy, deploy logs a
warning and continues. Fix the PR body and run the sync command manually if the
release note still needs to be published.

Add these values to production `.env.production`:

```env
RELEASE_DIGEST_AUTO_SEND_ENABLED=true
RELEASE_DIGEST_TIMEZONE=Asia/Bangkok
RELEASE_DIGEST_SEND_HOUR=21
RELEASE_DIGEST_CHECK_INTERVAL_MINUTES=15
GITHUB_TOKEN=<read-only GitHub token>
GITHUB_REPOSITORY=Eugenio-Minochkin/money_flow
```

`GITHUB_TOKEN` needs read access to pull requests. It remains on the production
server and is passed only to the API container. The deploy workflow never logs
the token.

## First-Time Server Setup

On your local machine, create a deploy key:

```bash
ssh-keygen -t ed25519 -C "money-flow-github-actions" -f money_flow_deploy_key
```

Copy the public key to the server deploy user:

```bash
ssh <user>@<server>
mkdir -p ~/.ssh
chmod 700 ~/.ssh
cat >> ~/.ssh/authorized_keys
```

Paste the contents of `money_flow_deploy_key.pub`, press Enter, then press Ctrl+D.

Add the private key contents from `money_flow_deploy_key` to GitHub as `PROD_SSH_KEY`.

The server should already have the repository at:

```bash
/opt/money-flow
```

The server directory must contain:

```bash
.env.production
compose.prod.yml
scripts/prod-security-check.sh
scripts/backup-postgres.sh
```

The deploy user needs permission to run:

```bash
cd /opt/money-flow
git fetch origin --prune --tags
git checkout --force <commit-sha>
ENV_FILE=/opt/money-flow/.env.production COMPOSE_FILE=/opt/money-flow/compose.prod.yml BACKUP_DIR=/opt/money-flow/backups/postgres ./scripts/backup-postgres.sh
docker compose --env-file .env.production -f compose.prod.yml build --pull --no-cache api
docker compose --env-file .env.production -f compose.prod.yml up -d --no-deps --force-recreate api
./scripts/prod-security-check.sh
docker compose --env-file .env.production -f compose.prod.yml exec -T api \
  npm run release-notes:sync-pr -- --pr=<pull-request-number>
```

## What Deploy Does

The workflow deploys a specific Git commit:

```bash
cd /opt/money-flow
git fetch origin --prune --tags
git checkout --force "$DEPLOY_REF"
ENV_FILE=/opt/money-flow/.env.production COMPOSE_FILE=/opt/money-flow/compose.prod.yml BACKUP_DIR=/opt/money-flow/backups/postgres ./scripts/backup-postgres.sh
docker compose --env-file .env.production -f compose.prod.yml build --pull --no-cache api
docker compose --env-file .env.production -f compose.prod.yml up -d --no-deps --force-recreate api
./scripts/prod-security-check.sh
docker compose --env-file .env.production -f compose.prod.yml exec -T api \
  npm run release-notes:sync-pr -- --pr="$RELEASE_PR_NUMBER"
```

The production database remains in the Docker volume. Application secrets remain in `.env.production`.
Before any container is rebuilt, recreated, restarted, or stopped, the deploy
creates and validates a fresh custom-format Postgres dump. A backup creation or
validation failure stops the deploy before the running containers are changed.
The workflow records the image ID produced by the no-cache API build and checks
that the recreated container runs that exact image. For revision-aware commits,
the container must also contain `/app/REVISION` equal to the checked-out Git
SHA; the log reports `Verification mode: exact revision`.

Older rollback targets created before the revision marker was introduced remain
deployable. The workflow selects this legacy path only when the target commit's
tracked `Dockerfile` does not contain the `/app/REVISION` mechanism. It then
requires the running container image ID to equal the freshly built image ID and
reports `Verification mode: legacy rollback`. An image-ID mismatch fails the
rollback; absence of `/app/REVISION` is never ignored for a revision-aware
target.
The post-start `prod-security-check.sh` remains a separate defense-in-depth
check.
The workflow also retries the public `https://${APP_DOMAIN}/health` endpoint and
requires `{ ok: true, db: true, revision: "<deployed SHA>" }`; a missing,
`unknown`, or stale revision fails deploy. It checks `getWebhookInfo` through a
temporary `0600` curl config (so the bot token never enters command output) and
requires the exact `https://${APP_DOMAIN}/telegram/webhook` URL. If either check
fails, do not change the webhook manually: inspect the public proxy upstream,
the Compose `api` container ID and `/app/REVISION`, then correct the mismatched
route or environment and rerun deploy. There must be one public API upstream
for the production bot.
The release-note sync step is intentionally non-blocking after health checks:
it should not roll back or fail a healthy application deploy.

## Planned Payment Telegram Reminders

The scheduler is enabled by default in production when the kill switch is omitted. Keep these values in `.env.production` to make the intended state explicit:

```env
PLANNED_PAYMENT_REMINDER_GLOBAL_ENABLED=true
PLANNED_PAYMENT_REMINDER_SEND_HOUR=21
```

Set `PLANNED_PAYMENT_REMINDER_GLOBAL_ENABLED=false` for an emergency stop. `PLANNED_PAYMENT_REMINDER_SEND_HOUR` is interpreted in each user's saved IANA timezone. Migration `013_planned_payment_reminders.sql` is additive and stores exact occurrence delivery/snooze state plus Telegram message references; it does not store descriptions or amounts.

## Postgres backup and restore

The production database lives in the Docker volume and holds user financial
data. These committed scripts create and verify `pg_restore`-compatible backups
without any host `pg_dump`/`pg_restore` client — all Postgres tooling runs
inside the `postgres` container via `docker compose`.

| Script | Purpose |
| --- | --- |
| `scripts/backup-postgres.sh` | Manual/custom-format backup + validation + retention + optional S3 copy |
| `scripts/install-postgres-backup-cron.sh` | Idempotent installer/checker for the supported server cron entry |
| `scripts/restore-postgres.sh` | Restore a `.dump` into an empty target DB (production-gated) |
| `scripts/test-postgres-restore.sh` | Automated backup→restore→verify drill (non-destructive) |

### Where backups are stored

- Default location: `backups/postgres/` (repo-relative). On the server that is
  `/opt/money-flow/backups/postgres`. Override with `BACKUP_DIR`.
- Filename: `moneyflow-postgres-YYYY-MM-DD_HH-MM-SS.dump` (local server time).
- Format: `pg_dump -Fc` custom format, restorable with `pg_restore`.
- Dump files are mode `0600`; the backup directory is mode `0700` and must not
  be broadly readable.
- `/backups/` is gitignored — dumps are never committed.

### Environment variables

The scripts only source `${ENV_FILE}` (with `set -a` / `set +a`) when it is
explicitly set; otherwise they rely on compose defaults. **On the server you
MUST set `ENV_FILE=.env.production` (and `COMPOSE_FILE=compose.prod.yml`).** Dev
needs neither — `docker-compose.yml` already defines the credentials.

| Variable | Default | Notes |
| --- | --- | --- |
| `ENV_FILE` | _(unset)_ | Required on the server: `.env.production`. Dev needs none. |
| `COMPOSE_FILE` | `docker-compose.yml` | Set to `compose.prod.yml` on the server. |
| `POSTGRES_DB` / `POSTGRES_USER` | `money_flow` | From `${ENV_FILE}` when set, else default. Never printed. |
| `POSTGRES_SERVICE` | `postgres` | Compose service name. |
| `BACKUP_DIR` | `backups/postgres` | Backup output directory. |
| `BACKUP_RETENTION_DAYS` | `14` | Deletes only `moneyflow-postgres-*.dump` older than N days. |
| `BACKUP_REMOTE_ENABLED` | `false` | Set to `true` to enable S3 upload. |
| `BACKUP_S3_BUCKET` | _(empty)_ | Required when remote is enabled. |
| `BACKUP_S3_PREFIX` | `money-flow/postgres` | S3 key prefix. |
| `BACKUP_S3_STORAGE_CLASS` | _(empty)_ | Optional, e.g. `STANDARD_IA`. |
| `RESTORE_TARGET_DB` | _(required)_ | Target DB for `restore-postgres.sh`. |
| `RESTORE_CONFIRM_PRODUCTION` | _(unset)_ | Set to `yes` to allow restoring into the app/maintenance DB. |

`aws s3 cp` uses `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`,
`AWS_DEFAULT_REGION` from the environment; never put these values in docs.

### Run a backup manually

Dev (uses `docker-compose.yml`; no env file needed — credentials come from compose):

```bash
./scripts/backup-postgres.sh
```

Production (sources `.env.production`, targets `compose.prod.yml`):

```bash
cd /opt/money-flow
ENV_FILE=.env.production COMPOSE_FILE=compose.prod.yml ./scripts/backup-postgres.sh
```

The script first writes a temporary host file, validates it with `pg_restore
--list` inside the Postgres container, removes that temporary container copy,
and only then atomically publishes the final `0600` dump. Retention and an
optional external upload run only after this validation. Expected log lines:
backup destination, created filename, byte size, retention summary, and either
`External upload complete.` or
`External backup upload is not configured, skipping.`

### Verify a backup was created

```bash
ls -lht backups/postgres/moneyflow-postgres-*.dump
test -s "$(ls -t backups/postgres/moneyflow-postgres-*.dump | head -1)" && echo "non-empty"
```

Validate the archive is a real `pg_restore` dump (see `docs/security-runbook.md`
→ Backup for the integrity-check commands). The production security check
(`scripts/prod-security-check.sh`) already enforces a fresh, valid `.dump` on
every deploy.

### How retention works

`BACKUP_RETENTION_DAYS` (default `14`) deletes only files matching
`moneyflow-postgres-*.dump` inside `BACKUP_DIR` that are older than the window.
Other files and subdirectories are never touched. Set to `0` to disable
automatic cleanup.

### Optional external copy (S3-compatible)

The backup script uploads to S3-compatible storage (S3, R2, B2, MinIO) **only**
when both `BACKUP_REMOTE_ENABLED=true` and `BACKUP_S3_BUCKET` are set, otherwise
it skips and logs the message above. To enable on the server, add to
`.env.production`:

```env
BACKUP_REMOTE_ENABLED=true
BACKUP_S3_BUCKET=your-bucket
BACKUP_S3_PREFIX=money-flow/postgres
# AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY / AWS_DEFAULT_REGION are read by the aws CLI.
```

The `aws` CLI must be installed on the host running the backup.

### Restore into an empty local/test database

```bash
# Dev: restore the latest backup into a throwaway database
RESTORE_TARGET_DB=money_flow_restore_check \
  ./scripts/restore-postgres.sh "$(ls -t backups/postgres/moneyflow-postgres-*.dump | head -1)"
```

The script drops/recreates `RESTORE_TARGET_DB`, runs `pg_restore
--no-owner --no-privileges`, and prints per-table row counts. For a one-shot
automated drill:

```bash
./scripts/test-postgres-restore.sh
```

### Commands that must NOT run against production without explicit confirmation

- Restoring into the application database (`POSTGRES_DB`), the `postgres`
  maintenance database, or any `template*` database. The restore script refuses
  these unless `RESTORE_CONFIRM_PRODUCTION=yes` is set.
- `DROP DATABASE`, `pg_restore` against a live production database, manual
  `DELETE`/`TRUNCATE`, or pointing seed/migration scripts at production.
- Anything destructive against the production volume or `.env.production`.

Restore drills always target a separate `*_restore_check` database and leave the
application database untouched.

### Recommended schedule (manual server action only)

Back up at least once per day. The repository contains an idempotent installer
for the supported `/etc/cron.d/money-flow-backup` entry, but neither the
repository nor the deploy workflow installs, edits, or otherwise modifies the
production scheduler automatically. Run these commands manually on the server:

```bash
cd /opt/money-flow
sudo ./scripts/install-postgres-backup-cron.sh
sudo ./scripts/install-postgres-backup-cron.sh --check
ls -lht /opt/money-flow/backups/postgres | head
journalctl -u cron --since today --no-pager | grep money-flow
tail -n 100 /opt/money-flow/logs/postgres-backup.log
```

The installer writes an explicit root-user cron entry with absolute
`ENV_FILE`, `COMPOSE_FILE`, `BACKUP_DIR`, and committed script paths, appending
logs to `/opt/money-flow/logs/postgres-backup.log`; it sets the cron file to
mode `0644`. After `--check` passes and an automatic run has been observed, you
may manually retire the legacy `/opt/money-flow/backup-postgres.sh`. Do not
delete or rename that legacy script automatically. A weekly restore drill
(`scripts/test-postgres-restore.sh`) is recommended to catch silent corruption.

## Docker Health and Hardening

The production API container runs as a non-root user and both containers expose
healthchecks, so `docker compose ps` reports real health instead of only
"running". Run these from the server checkout (`/opt/money-flow`):

```bash
# Show health status for api and postgres (look for "healthy" in the STATUS column)
docker compose --env-file .env.production -f compose.prod.yml ps

# Tail recent API logs
docker compose --env-file .env.production -f compose.prod.yml logs api --tail=100

# Confirm the API runs as a non-root user (must NOT print uid=0(root))
docker compose --env-file .env.production -f compose.prod.yml exec api id

# Check Postgres health directly inside the container
docker compose --env-file .env.production -f compose.prod.yml exec postgres pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB"
```

The API healthcheck hits the existing `GET /health` endpoint (a lightweight
`SELECT 1` against Postgres) and is marked healthy only when it returns
`200 { "ok": true, "db": true }`. The Postgres healthcheck uses `pg_isready`
with the user and database read from the container environment — no credentials
are hardcoded.

Startup order: the API service declares
`depends_on.postgres.condition: service_healthy`, so compose starts the API only
after Postgres passes its `pg_isready` healthcheck. This requires Docker Compose
v2 (the `docker compose` plugin already used by the deploy); it reduces, but does
not remove, the risk of the API starting before the database is reachable.

The application-level `runWithRetry` in `apps/api/src/db.js` (used by `migrate()`
at startup) stays in place as an additional fallback: if Postgres reports healthy
but the API still cannot open a connection for a moment, the retry loop handles it.
The Docker healthcheck/`depends_on` does not replace this retry logic.

### If the API is unhealthy

- `docker compose ... logs api --tail=100` — look for migration errors, missing
  env (`TELEGRAM_WEBHOOK_SECRET is required in production`), or DB connection
  failures.
- Confirm Postgres is healthy first (see below); the API cannot be healthy while
  Postgres is not.
- Restart the API: `docker compose ... restart api`, then re-check `ps`.

### If Postgres is unhealthy

- `docker compose ... logs postgres --tail=100` — look for data directory or
  configuration errors.
- Verify the volume is intact: `docker compose ... exec postgres pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB"`.
- Do not delete the `postgres_data` volume — it holds user financial data.
  Restart the service: `docker compose ... restart postgres`, then re-check.

## Rollback

Find the previous good commit:

```bash
git log --oneline
```

Open GitHub Actions, choose `CI and Deploy`, click `Run workflow`, and enter the
previous commit SHA in the `ref` input. This uses `workflow_dispatch` and runs
the same deploy steps against the older commit. A revision-aware rollback must
pass the exact `/app/REVISION` check. A commit from before the marker was added
uses the backward-compatible legacy check, which still fails unless the running
container uses the image ID saved immediately after the no-cache build.

## If Deploy Fails

Check the failed GitHub Actions log first.

Common causes:

- Missing or invalid GitHub SSH secret.
- Deploy user cannot access `/opt/money-flow`.
- Deploy user cannot run Docker.
- `.env.production` is missing on the server.
- `scripts/prod-security-check.sh` detects a failed health check or exposed Postgres port.

If only `release-notes:sync-pr` fails, the application deploy has already
passed health checks. Correct the `## User Release Notes` block in the PR body
and run the release sync command manually if needed.

Manual server check:

```bash
cd /opt/money-flow
docker compose --env-file .env.production -f compose.prod.yml ps
./scripts/prod-security-check.sh
```
