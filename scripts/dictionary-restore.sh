#!/usr/bin/env bash
#
# Restore a dictionary seed dump into an ALREADY MIGRATED database.
#
# THE PRECONDITION IS A MIGRATED, EMPTY DICTIONARY
#   The dump carries rows and no schema, so the tables have to exist first, and
#   the Drizzle migrations are what creates them. Restoring into a dictionary
#   that already holds rows will fail on the natural keys, which is the correct
#   outcome: this is a seed, not a merge. Truncate first if you mean to replace.
#
# WHY --disable-triggers
#   The nine tables reference each other, and pg_restore does not order rows
#   across tables by dependency. Deferring the foreign key checks for the load
#   is what lets the whole set land in one pass. It needs superuser rights,
#   which is why the restore runs as the postgres superuser rather than as the
#   application role.
set -euo pipefail

DUMP="${1:?usage: dictionary-restore.sh <dump-file>}"

cd "$(dirname "$0")/.."
if [ -f .env ]; then set -a; . ./.env; set +a; fi

DB_HOST="${DB_HOST:-localhost}"
DB_PORT="${DB_PORT:-5432}"
DB_USER="${DB_USER:-postgres}"
DB_NAME="${DB_NAME:?DB_NAME is required}"
DB_PASSWORD="${DB_PASSWORD:-}"

PGPASSWORD="$DB_PASSWORD" pg_restore \
  --host="$DB_HOST" --port="$DB_PORT" --username="$DB_USER" --dbname="$DB_NAME" \
  --data-only --disable-triggers --no-owner --no-privileges \
  --single-transaction "$DUMP"

echo "restored $DUMP into $DB_NAME"
