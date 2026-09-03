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
#
# --truncate-first, AND WHY IT IS NOT THE DEFAULT
#   Migration 0007 seeds one `sources` row (`llm-generated`), so even a freshly
#   migrated database is NOT empty in the dictionary zone, and a plain restore
#   dies on the slug unique constraint. --truncate-first empties the nine tables
#   before the load, which is what you want when seeding a new instance.
#   It is opt-in because it DELETES ROWS: on an instance that already carries a
#   dictionary, the default failure is the correct outcome.
set -euo pipefail

TRUNCATE_FIRST=0
if [ "${1:-}" = "--truncate-first" ]; then TRUNCATE_FIRST=1; shift; fi

DUMP="${1:?usage: dictionary-restore.sh [--truncate-first] <dump-file>}"

cd "$(dirname "$0")/.."
if [ -f .env ]; then set -a; . ./.env; set +a; fi

DB_HOST="${DB_HOST:-localhost}"
DB_PORT="${DB_PORT:-5432}"
DB_USER="${DB_USER:-postgres}"
DB_NAME="${DB_NAME:?DB_NAME is required}"
DB_PASSWORD="${DB_PASSWORD:-}"

TABLES="sources,headwords,senses,sense_versions,translations,headword_links,examples,example_headwords,entry_aliases"

if [ "$TRUNCATE_FIRST" = "1" ]; then
  echo "emptying the dictionary tables in $DB_NAME"
  PGPASSWORD="$DB_PASSWORD" psql -v ON_ERROR_STOP=1 \
    --host="$DB_HOST" --port="$DB_PORT" --username="$DB_USER" --dbname="$DB_NAME" \
    -c "TRUNCATE $TABLES RESTART IDENTITY CASCADE;"
fi

PGPASSWORD="$DB_PASSWORD" pg_restore \
  --host="$DB_HOST" --port="$DB_PORT" --username="$DB_USER" --dbname="$DB_NAME" \
  --data-only --disable-triggers --no-owner --no-privileges \
  --single-transaction "$DUMP"

echo "restored $DUMP into $DB_NAME"
