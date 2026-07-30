#!/usr/bin/env bash
# Install or check the supported production cron entry for Postgres backups.
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/money-flow}"
CRON_FILE="${CRON_FILE:-/etc/cron.d/money-flow-backup}"

render_cron() {
  cat <<EOF
SHELL=/bin/bash
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

15 2 * * * root cd $APP_DIR && ENV_FILE=$APP_DIR/.env.production COMPOSE_FILE=$APP_DIR/compose.prod.yml BACKUP_DIR=$APP_DIR/backups/postgres $APP_DIR/scripts/backup-postgres.sh >> $APP_DIR/logs/postgres-backup.log 2>&1
EOF
}

check_cron() {
  if [ ! -f "$CRON_FILE" ]; then
    echo "Postgres backup cron is missing: $CRON_FILE" >&2
    return 1
  fi
  if grep -Fq "$APP_DIR/backup-postgres.sh" "$CRON_FILE"; then
    echo "Postgres backup cron still references the legacy backup-postgres.sh path" >&2
    return 1
  fi
  if [ "$(stat -c '%a' "$CRON_FILE")" != "644" ]; then
    echo "Postgres backup cron must have mode 0644: $CRON_FILE" >&2
    return 1
  fi
  if ! diff -u <(render_cron) "$CRON_FILE" >/dev/null; then
    echo "Postgres backup cron is malformed: $CRON_FILE" >&2
    return 1
  fi
}

case "${1:-}" in
  --check)
    check_cron
    echo "Postgres backup cron check passed."
    exit 0
    ;;
  '')
    ;;
  *)
    echo "Usage: $0 [--check]" >&2
    exit 2
    ;;
esac

if [ "${EUID}" -ne 0 ]; then
  echo "This installer must run as root because it writes $CRON_FILE" >&2
  exit 1
fi

install -d -m 700 "$APP_DIR/logs" "$APP_DIR/backups/postgres"
cron_tmp="$(mktemp "${CRON_FILE}.XXXXXX")"
trap 'rm -f "$cron_tmp"' EXIT
render_cron > "$cron_tmp"
chmod 0644 "$cron_tmp"
install -m 0644 "$cron_tmp" "$CRON_FILE"
trap - EXIT
rm -f "$cron_tmp"

check_cron
echo "Postgres backup cron installed: $CRON_FILE"
