# Postgres Backup and Restore Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a committed, documented, manually runnable Postgres backup/restore workflow for Money Flow that replaces the ad-hoc server-only script, produces `pg_restore`-compatible dumps, keeps retention, supports an optional external copy, and is verified by a real restore drill.

**Architecture:** All DB tooling runs inside the `postgres` container via `docker compose exec`/`cp`, matching the existing restore-drill convention in `docs/security-runbook.md` and avoiding any host `pg_dump`/`pg_restore` dependency. Backups are custom-format (`pg_dump -Fc`) dumps written to `backups/postgres/`. The production security check is updated to validate the new format/path.

**Tech Stack:** Bash (`set -euo pipefail`), Docker Compose, `pg_dump`/`pg_restore` (Postgres 16), optional `aws` CLI for S3.

**Key decisions (from grilling):**
- Adopt `pg_dump -Fc` `.dump` format (task requirement: `pg_restore`-compatible), replacing the previous gzipped-SQL `.sql.gz` artifacts.
- Update `scripts/prod-security-check.sh` and `docs/security-runbook.md` to the new format/path. Production follow-up: repoint `/etc/cron.d/money-flow-backup` to `scripts/backup-postgres.sh` and remove the old server-only `/opt/money-flow/backup-postgres.sh`.
- Connection: `docker compose exec` inside the `postgres` container; overridable `COMPOSE_FILE`/`ENV_FILE` for dev vs prod.
- Retention: days-based (`BACKUP_RETENTION_DAYS=14`), scoped to `moneyflow-postgres-*.dump` only.

---

### Task 1: Backup script

**Files:**
- Create: `scripts/backup-postgres.sh`

- [ ] **Step 1:** Create `scripts/backup-postgres.sh` that:
  - sources `${ENV_FILE}` only when explicitly set (dev needs none; prod sets `ENV_FILE=.env.production`);
  - resolves `POSTGRES_DB`/`POSTGRES_USER` (dev defaults `money_flow`), `COMPOSE_FILE` (default `docker-compose.yml`), `POSTGRES_SERVICE` (default `postgres`), `BACKUP_DIR` (default `backups/postgres`);
  - creates `BACKUP_DIR`;
  - runs `docker compose ... exec -T "$POSTGRES_SERVICE" pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc` redirected to `moneyflow-postgres-YYYY-MM-DD_HH-MM-SS.dump`;
  - logs destination, filename, byte size, success/error; non-zero exit on failure;
  - applies retention (`BACKUP_RETENTION_DAYS=14`) deleting only `moneyflow-postgres-*.dump`;
  - runs guarded optional S3 upload (`BACKUP_REMOTE_ENABLED` + `BACKUP_S3_BUCKET`), else logs `External backup upload is not configured, skipping.`
  - never prints `POSTGRES_PASSWORD` or secrets.

### Task 2: Restore script

**Files:**
- Create: `scripts/restore-postgres.sh`

- [ ] **Step 1:** Create `scripts/restore-postgres.sh <backup-file>` that:
  - requires a backup file argument;
  - requires `RESTORE_TARGET_DB` to be set and to differ from `POSTGRES_DB` unless `RESTORE_CONFIRM_PRODUCTION=yes` (refuses production app DB otherwise);
  - DROPs IF EXISTS + CREATEs the target DB (only the explicit, non-app target) via the maintenance `postgres` DB;
  - `docker compose cp`s the dump into the container, runs `pg_restore --no-owner --no-privileges -U "$POSTGRES_USER" -d "$RESTORE_TARGET_DB"`, then removes the temp copy;
  - logs each step; non-zero exit on failure; never prints secrets.

### Task 3: Smoke-test script

**Files:**
- Create: `scripts/test-postgres-restore.sh`

- [ ] **Step 1:** Create a non-destructive end-to-end check that: builds a backup (into a temp `BACKUP_DIR`), restores it into a throwaway `money_flow_restore_check` DB, verifies core tables exist and have rows, then drops the throwaway DB and cleans the temp dir.

### Task 4: Security check + docs

**Files:**
- Modify: `scripts/prod-security-check.sh`
- Modify: `docs/security-runbook.md`
- Modify: `docs/deployment-runbook.md`
- Modify: `.gitignore`
- Modify: `.env.example`, `.env.production.example`

- [ ] **Step 1:** Update `scripts/prod-security-check.sh` backup check to find `backups/postgres/moneyflow-postgres-*.dump` newer than 2 days and validate via `pg_restore --list` (copy into container).
- [ ] **Step 2:** Update `docs/security-runbook.md`: Production Layout, Backup section (path/format/integrity), Restore Drill (`pg_restore`).
- [ ] **Step 3:** Add "Postgres backup and restore" section to `docs/deployment-runbook.md` (env vars, manual backup, retention, external copy, restore to empty DB, prod-gated commands, cron example).
- [ ] **Step 4:** Add `/backups/` to `.gitignore`; add new env vars to `.env.example`/`.env.production.example`.

### Task 5: Verify

- [ ] **Step 1:** Start dev Postgres, seed via `npm run dev:reset`, run `scripts/backup-postgres.sh`, confirm non-empty `.dump`.
- [ ] **Step 2:** Run `scripts/restore-postgres.sh` into `money_flow_restore_check`; verify tables/rows.
- [ ] **Step 3:** Run `npm test` (full suite green).
- [ ] **Step 4:** Commit, push, open PR with all required sections; stop for review.
