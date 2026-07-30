#!/usr/bin/env bash
#
# scripts/backup-postgres.sh
#
# Manual Postgres backup for Money Flow.
#
# Creates a custom-format (pg_restore-compatible) dump of the configured
# database, applies local retention, and optionally uploads the dump to
# S3-compatible storage. All pg tooling runs inside the postgres container via
# `docker compose exec`, so no host pg_dump/pg_restore client is required.
#
# Usage:
#   ./scripts/backup-postgres.sh                      # dev (docker-compose.yml + .env)
#   ENV_FILE=.env.production COMPOSE_FILE=compose.prod.yml ./scripts/backup-postgres.sh
#
# Never prints secrets (POSTGRES_PASSWORD, AWS credentials).

set -euo pipefail
umask 077

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT_DIR"

log() { echo "[backup-postgres] $*"; }
err() { echo "[backup-postgres] ERROR: $*" >&2; }

# --- Configuration ----------------------------------------------------------

# Source connection settings only when an env file is explicitly provided.
# Dev needs none (docker-compose.yml has hardcoded credentials + defaults below);
# prod sets ENV_FILE=.env.production.
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
BACKUP_DIR="${BACKUP_DIR:-backups/postgres}"
BACKUP_RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-14}"

alert_admin_backup_failure() {
  rc="$1"

  if [ "${ADMIN_ALERTS_ENABLED:-false}" != "true" ]; then
    return 0
  fi
  if [ -z "${TELEGRAM_BOT_TOKEN:-}" ] || [ -z "${ADMIN_TELEGRAM_IDS:-}" ]; then
    return 0
  fi
  if ! command -v curl >/dev/null 2>&1; then
    return 0
  fi

  alert_time="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  alert_text="$(printf 'Money Flow error\nsource: backup\njobName: postgres-backup\noperation: backup-postgres\nerror: BackupFailed\nmessage: backup-postgres exited with code %s\ntime: %s' "$rc" "$alert_time")"

  IFS=',' read -r -a alert_chat_ids <<< "$ADMIN_TELEGRAM_IDS"
  for raw_chat_id in "${alert_chat_ids[@]}"; do
    chat_id="$(printf '%s' "$raw_chat_id" | tr -d '[:space:]')"
    if [ -z "$chat_id" ]; then
      continue
    fi
    curl_config="$(mktemp "${TMPDIR:-/tmp}/money-flow-backup-alert.XXXXXX")"
    chmod 600 "$curl_config"
    printf 'url = "https://api.telegram.org/bot%s/sendMessage"\n' "$TELEGRAM_BOT_TOKEN" > "$curl_config"
    curl -fsS --max-time 5 --config "$curl_config" \
      --data-urlencode "chat_id=${chat_id}" \
      --data-urlencode "text=${alert_text}" >/dev/null 2>&1 || true
    rm -f "$curl_config"
  done
}

# Compose base command. Pass --env-file only when an explicit env file is given,
# so prod variable substitution (POSTGRES_DB/USER/PASSWORD) resolves correctly.
COMPOSE=(docker compose)
if [ -n "$ENV_FILE" ] && [ -f "$ENV_FILE" ]; then
  COMPOSE+=(--env-file "$ENV_FILE")
fi
COMPOSE+=(-f "$COMPOSE_FILE")

tmp_outfile=""
container_tmp=""

cleanup_container_tmp() {
  if [ -n "$container_tmp" ]; then
    MSYS_NO_PATHCONV=1 "${COMPOSE[@]}" exec -T "$POSTGRES_SERVICE" \
      rm -f "$container_tmp" >/dev/null 2>&1 || true
    container_tmp=""
  fi
}

cleanup_backup_artifacts() {
  if [ -n "$tmp_outfile" ]; then
    rm -f "$tmp_outfile" || true
    tmp_outfile=""
  fi
  cleanup_container_tmp
}

on_backup_exit() {
  rc="$?"
  trap - EXIT
  cleanup_backup_artifacts
  if [ "$rc" -ne 0 ]; then
    alert_admin_backup_failure "$rc"
  fi
  exit "$rc"
}

trap on_backup_exit EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

# --- Validate retention input ----------------------------------------------

case "$BACKUP_RETENTION_DAYS" in
  ''|*[!0-9]*)
    err "BACKUP_RETENTION_DAYS must be a non-negative integer, got: '$BACKUP_RETENTION_DAYS'"
    exit 2
    ;;
esac

# --- Create backup ----------------------------------------------------------

mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"

stamp="$(date +%Y-%m-%d_%H-%M-%S)"
outfile="$BACKUP_DIR/moneyflow-postgres-${stamp}.dump"
tmp_outfile="${outfile}.tmp.$$"
container_tmp="/tmp/money-flow-backup-validate-$$.dump"

log "Database:   $POSTGRES_DB (user: $POSTGRES_USER)"
log "Service:    $POSTGRES_SERVICE (compose: $COMPOSE_FILE)"
log "Backing up to: $outfile"

# pg_dump -Fc writes a custom-format archive to stdout; redirect to host file.
# Do NOT use `if ! pg_dump ...; then rc=$?` — inside that block $? is the
# negated status (0), so a failure would exit 0. Capture the real code in the
# else-branch instead.
if "${COMPOSE[@]}" exec -T "$POSTGRES_SERVICE" \
      pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc > "$tmp_outfile"; then
  :
else
  dump_rc=$?
  rm -f "$tmp_outfile"
  err "pg_dump failed (exit $dump_rc). Is the '$POSTGRES_SERVICE' container running?"
  exit "$dump_rc"
fi

if [ ! -s "$tmp_outfile" ]; then
  err "Backup file is empty: $outfile"
  exit 1
fi

chmod 600 "$tmp_outfile"

# The custom-format dump lives on the host. Copy it into the Postgres
# container for pg_restore validation, then always remove the container copy.
validation_ok=0
if "${COMPOSE[@]}" cp "$tmp_outfile" "${POSTGRES_SERVICE}:${container_tmp}" \
  && MSYS_NO_PATHCONV=1 "${COMPOSE[@]}" exec -T "$POSTGRES_SERVICE" \
    pg_restore --list "$container_tmp" >/dev/null 2>&1; then
  validation_ok=1
fi
cleanup_container_tmp

if [ "$validation_ok" -ne 1 ]; then
  err "Backup validation failed; invalid dump removed."
  exit 1
fi

mv -f "$tmp_outfile" "$outfile"
tmp_outfile=""
chmod 600 "$outfile"

size_bytes="$(wc -c < "$outfile")"
log "Created:    $outfile"
log "Size:       ${size_bytes} bytes"

# --- Retention --------------------------------------------------------------

# Delete ONLY moneyflow-postgres-*.dump files older than the retention window,
# inside BACKUP_DIR only. mtime +N = modified more than N*24h ago.
if [ "$BACKUP_RETENTION_DAYS" -gt 0 ]; then
  removed="$(find "$BACKUP_DIR" -maxdepth 1 -type f -name 'moneyflow-postgres-*.dump' -mtime +"$BACKUP_RETENTION_DAYS" -print -delete || true)"
else
  removed=""
fi
if [ -n "$removed" ]; then
  log "Retention:  removed backups older than ${BACKUP_RETENTION_DAYS} day(s):"
  echo "$removed" | sed 's/^/  - /'
else
  log "Retention:  nothing to remove (window: ${BACKUP_RETENTION_DAYS} day(s))."
fi

# --- Optional external copy -------------------------------------------------

if [ "${BACKUP_REMOTE_ENABLED:-false}" = "true" ]; then
  if [ -z "${BACKUP_S3_BUCKET:-}" ]; then
    err "BACKUP_REMOTE_ENABLED=true but BACKUP_S3_BUCKET is empty; skipping external upload."
  else
    prefix="${BACKUP_S3_PREFIX:-money-flow/postgres}"
    target="s3://${BACKUP_S3_BUCKET}/${prefix}/$(basename "$outfile")"
    log "Uploading to: $target"
    # aws reads AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY / AWS_DEFAULT_REGION from env.
    if aws s3 cp "$outfile" "$target" \
        ${BACKUP_S3_STORAGE_CLASS:+--storage-class "$BACKUP_S3_STORAGE_CLASS"}; then
      log "External upload complete."
    else
      upload_rc=$?
      err "External upload failed (aws exit $upload_rc). Local backup is still preserved."
      exit "$upload_rc"
    fi
  fi
else
  log "External backup upload is not configured, skipping."
fi

log "Done."
