#!/usr/bin/env bash
#
# scripts/test-postgres-restore.sh
#
# Non-destructive end-to-end backup/restore drill.
#
# 1. Counts rows in the source application database.
# 2. Runs scripts/backup-postgres.sh into a temporary backup directory.
# 3. Restores the dump into a throwaway database (money_flow_restore_check).
# 4. Verifies that the restored database has the same row counts.
# 5. Cleans up the throwaway database and the temporary backup directory.
#
# The application database is never modified or dropped by this script.
#
# Usage:
#   ./scripts/test-postgres-restore.sh
#   ENV_FILE=.env.production COMPOSE_FILE=compose.prod.yml ./scripts/test-postgres-restore.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT_DIR"

log() { echo "[test-postgres-restore] $*"; }
err() { echo "[test-postgres-restore] ERROR: $*" >&2; }

ENV_FILE="${ENV_FILE:-}"
if [ -n "$ENV_FILE" ] && [ -f "$ENV_FILE" ]; then
  set -a
  # shellcheck disable=SC1090
  . "$ENV_FILE"
  set +a
fi

POSTGRES_DB="${POSTGRES_DB:-money_flow}"
POSTGRES_USER="${POSTGRES_USER:-money_flow}"
POSTGRES_SERVICE="${POSTGRES_SERVICE:-postgres}"
COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.yml}"
TARGET_DB="${RESTORE_TARGET_DB:-money_flow_restore_check}"

COMPOSE=(docker compose)
if [ -n "$ENV_FILE" ] && [ -f "$ENV_FILE" ]; then
  COMPOSE+=(--env-file "$ENV_FILE")
fi
COMPOSE+=(-f "$COMPOSE_FILE")

TEMP_DIR="$(mktemp -d)"
cleanup() {
  rc=$?
  log "Cleaning up..."
  "${COMPOSE[@]}" exec -T "$POSTGRES_SERVICE" \
    psql -U "$POSTGRES_USER" -d postgres -c "DROP DATABASE IF EXISTS \"$TARGET_DB\";" >/dev/null 2>&1 || true
  rm -rf "$TEMP_DIR"
  exit "$rc"
}
trap cleanup EXIT

count_rows() {
  # $1 = database, $2 = table
  "${COMPOSE[@]}" exec -T "$POSTGRES_SERVICE" \
    psql -U "$POSTGRES_USER" -d "$1" -tAc "SELECT COUNT(*) FROM \"$2\";" 2>/dev/null || echo "MISSING"
}

log "Source DB: $POSTGRES_DB | Restore DB: $TARGET_DB | Compose: $COMPOSE_FILE"

# --- Source row counts ------------------------------------------------------

src_users="$(count_rows "$POSTGRES_DB" users)"
src_migrations="$(count_rows "$POSTGRES_DB" schema_migrations)"
log "Source counts: users=${src_users} schema_migrations=${src_migrations}"

if [ "$src_users" = "MISSING" ] || [ "$src_migrations" = "MISSING" ]; then
  err "Source database '$POSTGRES_DB' is missing expected tables."
  err "Seed it first, e.g.: npm run dev:reset"
  exit 1
fi

# --- Backup -----------------------------------------------------------------

log "Running backup into temp dir: $TEMP_DIR"
BACKUP_DIR="$TEMP_DIR" "$SCRIPT_DIR/backup-postgres.sh"

dump_file="$(find "$TEMP_DIR" -maxdepth 1 -type f -name 'moneyflow-postgres-*.dump' -print -quit)"
if [ -z "$dump_file" ]; then
  err "Backup did not produce a dump file."
  exit 1
fi
log "Backup created: $dump_file ($(wc -c < "$dump_file") bytes)"

# --- Restore ----------------------------------------------------------------

log "Restoring into throwaway database '$TARGET_DB'..."
RESTORE_TARGET_DB="$TARGET_DB" "$SCRIPT_DIR/restore-postgres.sh" "$dump_file"

# --- Verify -----------------------------------------------------------------

dst_users="$(count_rows "$TARGET_DB" users)"
dst_migrations="$(count_rows "$TARGET_DB" schema_migrations)"
log "Restore counts: users=${dst_users} schema_migrations=${dst_migrations}"

ok=1
if [ "$dst_users" != "$src_users" ]; then
  err "Row mismatch for 'users': source=${src_users} restored=${dst_users}"
  ok=0
fi
if [ "$dst_migrations" != "$src_migrations" ]; then
  err "Row mismatch for 'schema_migrations': source=${src_migrations} restored=${dst_migrations}"
  ok=0
fi

if [ "$ok" -ne 1 ]; then
  err "Restore drill FAILED: row counts do not match."
  exit 1
fi

log "PASS: backup and restore verified (users=${dst_users}, schema_migrations=${dst_migrations})."
