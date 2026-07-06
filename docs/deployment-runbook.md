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
```

The deploy user needs permission to run:

```bash
cd /opt/money-flow
git fetch origin --prune --tags
git checkout --force <commit-sha>
docker compose --env-file .env.production -f compose.prod.yml up -d --build
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
docker compose --env-file .env.production -f compose.prod.yml up -d --build
./scripts/prod-security-check.sh
docker compose --env-file .env.production -f compose.prod.yml exec -T api \
  npm run release-notes:sync-pr -- --pr="$RELEASE_PR_NUMBER"
```

The production database remains in the Docker volume. Application secrets remain in `.env.production`.
The release-note sync step is intentionally non-blocking after health checks:
it should not roll back or fail a healthy application deploy.

## Postgres backup and restore

The production database lives in the Docker volume and holds user financial
data. These committed scripts create and verify `pg_restore`-compatible backups
without any host `pg_dump`/`pg_restore` client — all Postgres tooling runs
inside the `postgres` container via `docker compose`.

| Script | Purpose |
| --- | --- |
| `scripts/backup-postgres.sh` | Manual/custom-format backup + retention + optional S3 copy |
| `scripts/restore-postgres.sh` | Restore a `.dump` into an empty target DB (production-gated) |
| `scripts/test-postgres-restore.sh` | Automated backup→restore→verify drill (non-destructive) |

### Where backups are stored

- Default location: `backups/postgres/` (repo-relative). On the server that is
  `/opt/money-flow/backups/postgres`. Override with `BACKUP_DIR`.
- Filename: `moneyflow-postgres-YYYY-MM-DD_HH-MM-SS.dump` (local server time).
- Format: `pg_dump -Fc` custom format, restorable with `pg_restore`.
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

Expected log lines: backup destination, created filename, byte size, retention
summary, and either `External upload complete.` or
`External backup upload is not configured, skipping.`

### Verify a backup was created

```bash
ls -lh backups/postgres/moneyflow-postgres-*.dump
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

### Recommended schedule (do not enable automatically from the repo)

Back up at least once per day. On the server, schedule the committed script via
cron (this is a server-side change; the repo does not install it for you):

```cron
15 2 * * * cd /opt/money-flow && ENV_FILE=.env.production COMPOSE_FILE=compose.prod.yml ./scripts/backup-postgres.sh >> /opt/money-flow/logs/postgres-backup.log 2>&1
```

Keep the existing `/etc/cron.d/money-flow-backup` pointing at
`scripts/backup-postgres.sh`. A weekly restore drill
(`scripts/test-postgres-restore.sh`) is recommended to catch silent corruption.

## Rollback

Find the previous good commit:

```bash
git log --oneline
```

Open GitHub Actions, choose `CI and Deploy`, click `Run workflow`, and enter the previous commit SHA in the `ref` input. This uses `workflow_dispatch` and runs the same deploy steps against the older commit.

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
