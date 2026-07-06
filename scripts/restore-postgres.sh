#!/usr/bin/env bash
#
# scripts/restore-postgres.sh <backup-file>
#
# Restores a Money Flow Postgres custom-format dump (.dump) created by
# scripts/backup-postgres.sh into an EMPTY target database via pg_restore.
#
# Safety:
#   - Restores into ${RESTORE_TARGET_DB}, which MUST be set.
#   - Refuses to touch the application database (${POSTGRES_DB}), the
#     maintenance database (postgres), or templates unless you explicitly set
#     RESTORE_CONFIRM_PRODUCTION=yes.
#   - DROPs IF EXISTS + CREATEs the target database (only the explicit target)
#     so the restore is clean and idempotent.
#   - Never prints secrets.
#
# Usage:
#   RESTORE_TARGET_DB=money_flow_restore_check \
#     ./scripts/restore-postgres.sh backups/postgres/moneyflow-postgres-2026-07-06_12-30-00.dump
#
#   # Restore into the real app DB (DESTRUCTIVE — needs explicit confirmation):
#   RESTORE_TARGET_DB=money_flow RESTORE_CONFIRM_PRODUCTION=yes \
#     ./scripts/restore-postgres.sh backups/postgres/<file>.dump

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT_DIR"

log() { echo "[restore-postgres] $*"; }
err() { echo "[restore-postgres] ERROR: $*" >&2; }

# --- Argument + config ------------------------------------------------------

backup_file="${1:-}"
if [ -z "$backup_file" ]; then
  err "Usage: $0 <backup-file>"
  err "Set RESTORE_TARGET_DB to the (empty) database to restore into."
  exit 2
fi

# Resolve to an absolute path so it survives any later cd / container copy.
backup_file="$(cd "$(dirname "$backup_file")" && pwd)/$(basename "$backup_file")"

if [ ! -f "$backup_file" ]; then
  err "Backup file not found: $backup_file"
  exit 2
fi
if [ ! -s "$backup_file" ]; then
  err "Backup file is empty: $backup_file"
  exit 2
fi

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

COMPOSE=(docker compose)
if [ -n "$ENV_FILE" ] && [ -f "$ENV_FILE" ]; then
  COMPOSE+=(--env-file "$ENV_FILE")
fi
COMPOSE+=(-f "$COMPOSE_FILE")

# Run a command inside the postgres container. MSYS_NO_PATHCONV stops Git Bash on
# Windows from rewriting container-internal paths (e.g. /tmp/...) into Windows
# paths. Harmless on Linux/macOS. (docker compose cp is NOT routed through here,
# so host paths still get translated for the copy.)
compose_exec() {
  MSYS_NO_PATHCONV=1 "${COMPOSE[@]}" exec -T "$POSTGRES_SERVICE" "$@"
}

# --- Target database safety gate -------------------------------------------

if [ -z "${RESTORE_TARGET_DB:-}" ]; then
  err "RESTORE_TARGET_DB is required. Set it to an empty/throwaway database."
  err "Refusing to restore without an explicit, non-production target."
  exit 2
fi

# Prevent SQL identifier injection; RESTORE_TARGET_DB must be a plain identifier.
if ! printf '%s' "$RESTORE_TARGET_DB" | grep -Eq '^[A-Za-z_][A-Za-z0-9_]*$'; then
  err "RESTORE_TARGET_DB must match [A-Za-z_][A-Za-z0-9_]* (got: '$RESTORE_TARGET_DB')."
  exit 2
fi

protected="$POSTGRES_DB"
case "$RESTORE_TARGET_DB" in
  "$POSTGRES_DB"|postgres|template0|template1)
    if [ "${RESTORE_CONFIRM_PRODUCTION:-}" != "yes" ]; then
      err "RESTORE_TARGET_DB ('$RESTORE_TARGET_DB') is a protected database."
      err "Restoring here is DESTRUCTIVE. To confirm, set RESTORE_CONFIRM_PRODUCTION=yes."
      exit 2
    fi
    log "WARNING: restoring into protected database '$RESTORE_TARGET_DB' (confirmed)."
    ;;
esac

log "Backup file: $backup_file"
log "Target DB:   $RESTORE_TARGET_DB (app DB: $POSTGRES_DB)"
log "Service:     $POSTGRES_SERVICE (compose: $COMPOSE_FILE)"
log "NOTE: target database '$RESTORE_TARGET_DB' will be dropped and recreated."

# --- Validate archive before any destructive step ---------------------------

# Custom-format archives require a seekable file, so copy the dump into the
# container rather than piping it.
tmp_remote="/tmp/moneyflow-restore-$$.dump"

log "Validating archive..."
"${COMPOSE[@]}" cp "$backup_file" "$POSTGRES_SERVICE:$tmp_remote"
if ! compose_exec pg_restore --list "$tmp_remote" >/dev/null; then
  compose_exec rm -f "$tmp_remote" >/dev/null 2>&1 || true
  err "Backup archive is not a valid pg_restore custom-format dump: $backup_file"
  exit 1
fi

# --- Recreate the (empty) target database -----------------------------------

psql_exec() {
  compose_exec psql -U "$POSTGRES_USER" -d postgres -v ON_ERROR_STOP=1 "$@"
}

log "Dropping/creating target database '$RESTORE_TARGET_DB'..."
psql_exec -c "DROP DATABASE IF EXISTS \"$RESTORE_TARGET_DB\";"
psql_exec -c "CREATE DATABASE \"$RESTORE_TARGET_DB\";"

# --- Restore ----------------------------------------------------------------

log "Restoring (pg_restore)..."
if ! compose_exec pg_restore -U "$POSTGRES_USER" -d "$RESTORE_TARGET_DB" \
      --no-owner --no-privileges "$tmp_remote"; then
  rc=$?
  compose_exec rm -f "$tmp_remote" >/dev/null 2>&1 || true
  err "pg_restore failed (exit $rc). The target database '$RESTORE_TARGET_DB' may be partial."
  exit "$rc"
fi

compose_exec rm -f "$tmp_remote" >/dev/null 2>&1 || true

# --- Verify -----------------------------------------------------------------

log "Restore complete. Row counts in '$RESTORE_TARGET_DB':"
compose_exec psql -U "$POSTGRES_USER" -d "$RESTORE_TARGET_DB" -c \
  "SELECT relname AS table, n_live_tup AS approx_rows FROM pg_stat_user_tables ORDER BY n_live_tup DESC;"

log "Done."
