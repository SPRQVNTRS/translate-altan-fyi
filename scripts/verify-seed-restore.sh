#!/usr/bin/env bash
#
# Prove the published seed dump restores into an EMPTY database and yields rows.
#
# WHY THIS EXISTS AT ALL
#   `pg_restore --data-only` prints "errors ignored on restore" and exits 0 when
#   every single COPY failed. A dump file that exists, and a restore that
#   "succeeded", together prove nothing. The only evidence is a row count taken
#   after the load, which is what this prints.
#
# WHAT IT DOES
#   Creates a throwaway database on the local Postgres, runs the Drizzle
#   migrations against it (the dump carries rows, never schema), restores the
#   dump with --single-transaction so the first error is fatal, counts the nine
#   dictionary tables, then drops the database. The drop runs on every exit path.
#
# Usage:
#   scripts/verify-seed-restore.sh                        # counts
#   scripts/verify-seed-restore.sh --sources              # print the sources rows
#   scripts/verify-seed-restore.sh --assert-no-personal-data
#
# The dump is taken from SEED_DUMP if set, else the newest
# dictionary-seed-*.dump in the repo root, else it is downloaded from the URL in
# the README.
set -euo pipefail

cd "$(dirname "$0")/.."

MODE="${1:-counts}"

PG_CONTAINER="${DICTIONARY_PG_CONTAINER:-projects-postgres-1}"
PG_SUPERUSER="${SEED_PG_SUPERUSER:-postgres}"
PG_PASSWORD="${SEED_PG_PASSWORD:-postgres}"
PG_HOST="${SEED_PG_HOST:-localhost}"
PG_PORT="${SEED_PG_PORT:-5433}"
VERIFY_DB="verify_seed_$$"

psql_root() { docker exec -e PGPASSWORD="$PG_PASSWORD" "$PG_CONTAINER" psql -v ON_ERROR_STOP=1 -U "$PG_SUPERUSER" -d postgres "$@"; }
psql_db()   { docker exec -e PGPASSWORD="$PG_PASSWORD" "$PG_CONTAINER" psql -v ON_ERROR_STOP=1 -U "$PG_SUPERUSER" -d "$VERIFY_DB" "$@"; }

# --- locate the dump -----------------------------------------------------

DUMP="${SEED_DUMP:-}"
if [ -z "$DUMP" ]; then
  DUMP="$(ls -1t dictionary-seed-*.dump 2>/dev/null | head -1 || true)"
fi
if [ -z "$DUMP" ] || [ ! -f "$DUMP" ]; then
  URL="$(grep -Eo 'https://[^ )]*seed[^ )]*\.dump' README.md | head -1)"
  if [ -z "$URL" ]; then
    echo "✖ no dump found and no download URL in README.md" >&2
    exit 1
  fi
  DUMP="$(mktemp -u "$PWD/dictionary-seed-downloaded-XXXXXX").dump"
  echo "▶ downloading $URL"
  curl -fsSL -o "$DUMP" "$URL"
  DOWNLOADED=1
fi
echo "▶ dump: $DUMP ($(du -h "$DUMP" | cut -f1))"

# --- throwaway database --------------------------------------------------

cleanup() {
  psql_root -c "DROP DATABASE IF EXISTS \"$VERIFY_DB\" WITH (FORCE);" >/dev/null 2>&1 || true
  [ "${DOWNLOADED:-0}" = "1" ] && rm -f "$DUMP"
  return 0
}
trap cleanup EXIT

echo "▶ creating $VERIFY_DB"
psql_root -c "CREATE DATABASE \"$VERIFY_DB\";" >/dev/null

# --- migrations ----------------------------------------------------------
#
# The schema comes from the Drizzle migrations, never from the dump. That is the
# whole reason the dump is data-only: a schema-carrying dump would be a second,
# silently diverging copy of the migration history.

if [ -f /run/.containerenv ] || [ -f /.dockerenv ]; then
  run() { CI=true "$@"; }
elif command -v toolbox >/dev/null 2>&1; then
  run() { toolbox run -c ts-dev env CI=true "$@"; }
else
  echo "✖ verify-seed-restore: no ts-dev toolbox and not inside a container." >&2
  exit 1
fi

echo "▶ running migrations against $VERIFY_DB"
run env \
  DB_HOST="$PG_HOST" DB_PORT="$PG_PORT" DB_USER="$PG_SUPERUSER" \
  DB_PASSWORD="$PG_PASSWORD" DB_NAME="$VERIFY_DB" \
  pnpm drizzle:migrate >/dev/null

# --- restore -------------------------------------------------------------
#
# --single-transaction turns the first error into a non-zero exit. Without it a
# restore in which every COPY failed still exits 0.

# Migration 0007 seeds one `sources` row, so a freshly migrated database is not
# empty in the dictionary zone and a plain restore dies on the slug unique
# constraint. This is the same step `dictionary-restore.sh --truncate-first`
# performs, kept here so the verification runs the documented path.
echo "▶ emptying the dictionary tables"
psql_db -c "TRUNCATE sources,headwords,senses,sense_versions,translations,headword_links,examples,example_headwords,entry_aliases RESTART IDENTITY CASCADE;" >/dev/null

echo "▶ restoring with --single-transaction"
docker exec -i -e PGPASSWORD="$PG_PASSWORD" "$PG_CONTAINER" pg_restore \
  --username="$PG_SUPERUSER" --dbname="$VERIFY_DB" \
  --data-only --disable-triggers --no-owner --no-privileges \
  --single-transaction < "$DUMP"

# --- the evidence --------------------------------------------------------

if [ "$MODE" = "--sources" ]; then
  echo
  echo "sources (the attribution registry a restored instance renders):"
  psql_db -c "SELECT name, licence, attribution FROM sources ORDER BY name;"
  exit 0
fi

if [ "$MODE" = "--assert-no-personal-data" ]; then
  leaked=0
  for table in accounts sync_blobs sync_key_records; do
    n="$(psql_db -tAc "SELECT count(*) FROM $table;")"
    echo "$table: $n"
    [ "$n" = "0" ] || leaked=1
  done
  if [ "$leaked" = "1" ]; then
    echo "✖ the seed dump carries personal-zone rows. Do NOT publish it." >&2
    exit 1
  fi
  echo "✅ no personal-zone rows in the restored database"
  exit 0
fi

echo
for table in headwords senses sense_versions translations examples example_headwords headword_links entry_aliases sources; do
  echo "$table: $(psql_db -tAc "SELECT count(*) FROM $table;")"
done
