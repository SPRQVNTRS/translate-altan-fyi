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
#
# WHY IT SHELLS OUT TO DOCKER
#   The workstation and the ts-dev toolbox have no postgres client binaries,
#   so psql and pg_restore are run inside the Postgres container. That is the
#   same arrangement make-seed-dump.sh uses, and it matters for more than
#   convenience: a dump written by one client version and read by another is
#   how a restore fails halfway. Set DICTIONARY_PG_LOCAL=1 to use binaries on
#   PATH instead, or DICTIONARY_PG_CONTAINER to name another container.
set -euo pipefail

TRUNCATE_FIRST=0
if [ "${1:-}" = "--truncate-first" ]; then TRUNCATE_FIRST=1; shift; fi

DUMP="${1:?usage: dictionary-restore.sh [--truncate-first] <dump-file>}"

cd "$(dirname "$0")/.."
# THE CALLER'S ENVIRONMENT WINS OVER .env, WHICH IS NOT WHAT `set -a` DOES.
#   Sourcing .env with `set -a` overwrites variables the caller exported, so
#   `DB_NAME=other scripts/dictionary-restore.sh dump` silently restored into
#   whatever .env named instead. That is a data-loss shape: this script
#   truncates before it loads, so the wrong database is emptied and the
#   operator is told the right one succeeded. The four connection variables are
#   therefore captured first and put back afterwards.
CALLER_DB_HOST="${DB_HOST:-}"
CALLER_DB_PORT="${DB_PORT:-}"
CALLER_DB_USER="${DB_USER:-}"
CALLER_DB_NAME="${DB_NAME:-}"
CALLER_DB_PASSWORD="${DB_PASSWORD:-}"
if [ -f .env ]; then set -a; . ./.env; set +a; fi
if [ -n "$CALLER_DB_HOST" ]; then DB_HOST="$CALLER_DB_HOST"; fi
if [ -n "$CALLER_DB_PORT" ]; then DB_PORT="$CALLER_DB_PORT"; fi
if [ -n "$CALLER_DB_USER" ]; then DB_USER="$CALLER_DB_USER"; fi
if [ -n "$CALLER_DB_NAME" ]; then DB_NAME="$CALLER_DB_NAME"; fi
if [ -n "$CALLER_DB_PASSWORD" ]; then DB_PASSWORD="$CALLER_DB_PASSWORD"; fi

DB_HOST="${DB_HOST:-localhost}"
DB_PORT="${DB_PORT:-5432}"
DB_USER="${DB_USER:-postgres}"
DB_NAME="${DB_NAME:?DB_NAME is required}"
DB_PASSWORD="${DB_PASSWORD:-}"
TABLES="sources,headwords,senses,sense_versions,translations,headword_links,examples,example_headwords,entry_aliases"

# WHERE THE POSTGRES CLIENT BINARIES ARE, WHICH IS NOT ON THIS HOST.
#   Neither the workstation nor the `ts-dev` toolbox carries `psql` or
#   `pg_restore`, so a bare call fails with "command not found" rather than with
#   anything about the database. `make-seed-dump.sh` solved this by shelling out
#   to the Postgres container, and this script uses the same two switches so the
#   dump and the restore cannot end up on two different client versions.
#
#   DICTIONARY_PG_LOCAL=1 uses binaries on PATH, for a machine that has them.
#   DICTIONARY_PG_CONTAINER names another container. The default is the
#   workspace's shared Postgres.
CONTAINER="${DICTIONARY_PG_CONTAINER:-projects-postgres-1}"
INNER_HOST="$DB_HOST"
if [ "$INNER_HOST" = "localhost" ] || [ "$INNER_HOST" = "127.0.0.1" ]; then INNER_HOST=localhost; fi

run_psql() {
  if [ "${DICTIONARY_PG_LOCAL:-0}" = "1" ]; then
    PGPASSWORD="$DB_PASSWORD" psql -v ON_ERROR_STOP=1 \
      --host="$DB_HOST" --port="$DB_PORT" --username="$DB_USER" --dbname="$DB_NAME" "$@"
  else
    docker exec -e PGPASSWORD="$DB_PASSWORD" "$CONTAINER" psql -v ON_ERROR_STOP=1 \
      --host="$INNER_HOST" --port=5432 --username="$DB_USER" --dbname="$DB_NAME" "$@"
  fi
}

# NAMED OUT LOUD BEFORE ANYTHING IS EMPTIED. The one failure this script can
# cause is truncating a database the operator did not mean, so the target is
# printed on every run rather than only in the success line at the end.
echo "target: $DB_NAME on $DB_HOST:$DB_PORT as $DB_USER"

if [ "$TRUNCATE_FIRST" = "1" ]; then
  echo "emptying the dictionary tables in $DB_NAME"
  run_psql -c "TRUNCATE $TABLES RESTART IDENTITY CASCADE;"
fi

# --single-transaction IS NOT OPTIONAL. pg_restore exits 0 on a load that
# failed row by row, so without it a half-restored dictionary reports success.
if [ "${DICTIONARY_PG_LOCAL:-0}" = "1" ]; then
  PGPASSWORD="$DB_PASSWORD" pg_restore \
    --host="$DB_HOST" --port="$DB_PORT" --username="$DB_USER" --dbname="$DB_NAME" \
    --data-only --disable-triggers --no-owner --no-privileges \
    --single-transaction "$DUMP"
else
  # pg_restore needs a seekable file, so the dump is streamed to a path inside
  # the container rather than piped to its stdin.
  docker exec -i -e PGPASSWORD="$DB_PASSWORD" "$CONTAINER" \
    sh -c "cat > /tmp/dictionary-restore.dump \
      && pg_restore --host=$INNER_HOST --port=5432 --username=$DB_USER --dbname=$DB_NAME \
           --data-only --disable-triggers --no-owner --no-privileges \
           --single-transaction /tmp/dictionary-restore.dump; \
       status=\$?; rm -f /tmp/dictionary-restore.dump; exit \$status" < "$DUMP"
fi

echo "restored $DUMP into $DB_NAME"
