#!/usr/bin/env bash
#
# Produce the PUBLISHABLE seed dump of the shared dictionary zone, plus its md5.
#
# WHAT THIS IS FOR
#   `dictionary-dump.sh` is the operational dump, used to move the dictionary
#   between our own environments. This script produces the artifact a STRANGER
#   downloads and restores, which is a different risk: it leaves the building.
#   So it repeats the same nine-table selection and then names, one by one,
#   every table it must not carry.
#
# WHY BOTH --table AND --exclude-table
#   `--table` alone already limits the dump to the nine dictionary tables, so
#   the exclusions are redundant TODAY. They are here because the failure they
#   guard against is a future edit to the include list, not a bug in this one.
#   pg_dump resolves --exclude-table AFTER --table, so an accidental include of
#   a personal-zone table cannot win. A leak here is unrecoverable: the dump is
#   on the internet before anybody reads the diff.
#
# WHAT THE DUMP CARRIES
#   sources, headwords, senses, sense_versions, translations, headword_links,
#   examples, example_headwords, entry_aliases. Rows only, no schema: the
#   Drizzle migrations create the tables on the other side.
#
#   `sources` is not optional. Without it a restored instance renders the
#   dictionary with no attribution, which breaks the CC BY terms the whole data
#   policy rests on. `languages` is deliberately absent: the migration seeds it
#   in every environment, so shipping it would collide on the primary key.
#
# WHY IT SHELLS OUT TO DOCKER
#   The ts-dev toolbox has no postgres client binaries. The workspace's shared
#   Postgres runs in `projects-postgres-1`, and its pg_dump is the one that
#   matches the server. Set DICTIONARY_PG_CONTAINER to point at another one, or
#   set DICTIONARY_PG_LOCAL=1 to use a pg_dump on PATH instead.
#
# Usage: scripts/make-seed-dump.sh [output-file]
set -euo pipefail

cd "$(dirname "$0")/.."
if [ -f .env ]; then set -a; . ./.env; set +a; fi

DB_HOST="${DB_HOST:-localhost}"
DB_PORT="${DB_PORT:-5432}"
DB_USER="${DB_USER:-postgres}"
DB_NAME="${DB_NAME:-translate_altan_fyi}"
DB_PASSWORD="${DB_PASSWORD:-postgres}"

# The shared dictionary zone. These nine and nothing else.
TABLES="sources headwords senses sense_versions translations headword_links examples example_headwords entry_aliases"

# Every other table in the database, named explicitly. Keep this list in step
# with drizzle/schema/*.ts: a new table belongs in one of these two lists, and
# if you are unsure, it belongs in this one.
EXCLUDE_FLAGS="
--exclude-table=public.accounts
--exclude-table=public.account_tokens
--exclude-table=public.sync_blobs
--exclude-table=public.sync_key_records
--exclude-table=public.api_keys
--exclude-table=public.users
--exclude-table=public.organizations
--exclude-table=public.organization_members
--exclude-table=public.enrichments
--exclude-table=public.enrichment_votes
--exclude-table=public.reenrichment_log
--exclude-table=public.abuse_counters
--exclude-table=public.abuse_rejections
--exclude-table=public.alert_log
--exclude-table=public.metric_events
--exclude-table=public.daily_budget
--exclude-table=public.app_settings
--exclude-table=public.app_settings_audit
--exclude-table=public.data_migrations
--exclude-table=public.data_sources
--exclude-table=public.languages
--exclude-table=public.articles
--exclude-table=public.categories
--exclude-table=public.pages
--exclude-table=public.workflows
--exclude-table=public.workflow_locks
--exclude-table=public.workflow_operations
"

OUT="${1:-dictionary-seed-$(date -u +%Y-%m-%d).dump}"

ARGS=""
for table in $TABLES; do ARGS="$ARGS --table=public.$table"; done
for flag in $EXCLUDE_FLAGS; do ARGS="$ARGS $flag"; done

if [ "${DICTIONARY_PG_LOCAL:-0}" = "1" ]; then
  PGPASSWORD="$DB_PASSWORD" pg_dump \
    --host="$DB_HOST" --port="$DB_PORT" --username="$DB_USER" --dbname="$DB_NAME" \
    --data-only --format=custom --no-owner --no-privileges $ARGS > "$OUT"
else
  CONTAINER="${DICTIONARY_PG_CONTAINER:-projects-postgres-1}"
  INNER_HOST="$DB_HOST"
  if [ "$INNER_HOST" = "localhost" ] || [ "$INNER_HOST" = "127.0.0.1" ]; then INNER_HOST=localhost; fi
  docker exec -e PGPASSWORD="$DB_PASSWORD" "$CONTAINER" pg_dump \
    --host="$INNER_HOST" --port=5432 --username="$DB_USER" --dbname="$DB_NAME" \
    --data-only --format=custom --no-owner --no-privileges $ARGS > "$OUT"
fi

# The checksum ships next to the dump so a downloader can tell a truncated
# transfer from a corrupt one before spending minutes on a restore.
md5sum "$OUT" | sed "s| .*| $(basename "$OUT")|" > "$OUT.md5"

echo "wrote $OUT ($(du -h "$OUT" | cut -f1))"
echo "wrote $OUT.md5"
echo
echo "Tables in the dump:"
# Listed from the artifact itself, not from the variables above: the point is to
# show what landed, not to repeat the intent. pg_restore runs in the container
# because the host has no postgres client binaries.
if [ "${DICTIONARY_PG_LOCAL:-0}" = "1" ]; then
  pg_restore --list "$OUT"
else
  # pg_restore needs a seekable file, so the dump is streamed to a temp path
  # inside the container rather than piped to /dev/stdin.
  docker exec -i "${DICTIONARY_PG_CONTAINER:-projects-postgres-1}" \
    sh -c 'cat > /tmp/seed-list.dump && pg_restore --list /tmp/seed-list.dump; rm -f /tmp/seed-list.dump' < "$OUT"
fi | grep -Eo 'TABLE DATA public [a-z_]+' | awk '{print "  " $4}' | sort -u
