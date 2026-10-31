#!/usr/bin/env bash
# Vaharo MySQL backup. Consistent snapshot without locking tables (InnoDB).
#
#   DB_HOST=... DB_PORT=3306 DB_USER=... DB_PASSWORD=... DB_NAME=... ./scripts/backup-db.sh
#
# Writes backups/vaharo-YYYYMMDD-HHMMSS.sql.gz and keeps the newest $KEEP files (default 14).
# Schedule daily with cron, and copy the files off the server (backups on the same disk are
# not backups). See docs/DEPLOYMENT.md for the restore steps.
set -euo pipefail

: "${DB_HOST:?set DB_HOST}"
: "${DB_USER:?set DB_USER}"
: "${DB_PASSWORD:?set DB_PASSWORD}"
: "${DB_NAME:?set DB_NAME}"
DB_PORT="${DB_PORT:-3306}"
KEEP="${KEEP:-14}"
DIR="${BACKUP_DIR:-$(dirname "$0")/../backups}"

mkdir -p "$DIR"
FILE="$DIR/vaharo-$(date +%Y%m%d-%H%M%S).sql.gz"

# Password via env var, not the command line, so it does not show in the process list.
MYSQL_PWD="$DB_PASSWORD" mysqldump \
  --host="$DB_HOST" --port="$DB_PORT" --user="$DB_USER" \
  --single-transaction --quick --routines --triggers --no-tablespaces \
  --default-character-set=utf8mb4 \
  "$DB_NAME" | gzip -9 > "$FILE"

# Fail loudly if the dump is suspiciously small.
if [ "$(gzip -dc "$FILE" | grep -c 'CREATE TABLE')" -lt 5 ]; then
  echo "Backup looks incomplete: $FILE" >&2
  exit 1
fi

ls -1t "$DIR"/vaharo-*.sql.gz | tail -n +"$((KEEP + 1))" | xargs -r rm --
echo "Backup written: $FILE"
