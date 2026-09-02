#!/usr/bin/env bash
#
# Dump the shared dictionary as a seed file.
#
# WHY DATA ONLY, AND WHY CUSTOM FORMAT
#   The schema on the other side is created by the Drizzle migrations, never by
#   a dump. A schema-carrying dump would be a second, silently diverging copy of
#   the migration history, and restoring it would leave the `drizzle` journal
#   disagreeing with the tables. So this dumps ROWS only.
#   The custom format is what lets the restore side pass --disable-triggers and
#   pick tables, which a plain SQL file cannot do.
#
# WHY THESE NINE TABLES AND NOT THE WHOLE DATABASE
#   The dictionary is the only shared, reproducible-from-open-data zone. Users,
#   organizations, api keys and workflow rows are per-environment state and must
#   never travel in a seed file.
#
#   `languages` is NOT in the list on purpose: it is seeded by the migration on
#   every environment, so shipping it would collide on the primary key.
#
# WHY IT SHELLS OUT TO DOCKER
#   The ts-dev toolbox has no postgres client binaries. The workspace's shared
#   Postgres runs in `projects-postgres-1`, and its pg_dump is the one that
#   matches the server. Set DICTIONARY_PG_CONTAINER to point at another one, or
#   set DICTIONARY_PG_LOCAL=1 to use a pg_dump on PATH instead.
#
# Reads the usual DB_* variables, the same ones the app and the CLI read.
set -euo pipefail

cd "$(dirname "$0")/.."
if [ -f .env ]; then set -a; . ./.env; set +a; fi

DB_HOST="${DB_HOST:-localhost}"
DB_PORT="${DB_PORT:-5432}"
DB_USER="${DB_USER:-postgres}"
DB_NAME="${DB_NAME:?DB_NAME is required}"
DB_PASSWORD="${DB_PASSWORD:-}"

TABLES="sources headwords senses sense_versions translations headword_links examples example_headwords entry_aliases"
OUT="${1:-dictionary-seed-$(date -u +%Y-%m-%d).dump}"

ARGS=""
for table in $TABLES; do ARGS="$ARGS --table=public.$table"; done

# The dump is written to stdout and captured here, so the file lands on THIS
# machine even when pg_dump itself runs inside a container.
if [ "${DICTIONARY_PG_LOCAL:-0}" = "1" ]; then
  PGPASSWORD="$DB_PASSWORD" pg_dump \
    --host="$DB_HOST" --port="$DB_PORT" --username="$DB_USER" --dbname="$DB_NAME" \
    --data-only --format=custom --no-owner --no-privileges $ARGS > "$OUT"
else
  CONTAINER="${DICTIONARY_PG_CONTAINER:-projects-postgres-1}"
  # `localhost` names the host from outside the container and the container
  # itself from inside it, and the database lives inside it, so it is the right
  # host in both readings. Any other DB_HOST is passed through untouched.
  INNER_HOST="$DB_HOST"
  if [ "$INNER_HOST" = "localhost" ] || [ "$INNER_HOST" = "127.0.0.1" ]; then INNER_HOST=localhost; fi
  docker exec -e PGPASSWORD="$DB_PASSWORD" "$CONTAINER" pg_dump \
    --host="$INNER_HOST" --port=5432 --username="$DB_USER" --dbname="$DB_NAME" \
    --data-only --format=custom --no-owner --no-privileges $ARGS > "$OUT"
fi

echo "wrote $OUT ($(du -h "$OUT" | cut -f1))"
