#!/usr/bin/env bash
#
# Bring up a complete local instance of kenning.altan.fyi, from nothing.
#
# WHAT "COMPLETE" MEANS HERE, AND WHY IT TAKES A SCRIPT
#   Three separate things have to be true before this app answers a single
#   query, and each one used to be a paragraph of a README that somebody had to
#   read and follow by hand:
#
#     1. the schema exists          -> drizzle migrations
#     2. the dictionary has rows    -> the checked-in seed dump
#     3. an account exists AND its email is verified -> drizzle/seed.ts
#
#   Miss the third and the app looks broken rather than empty. The main screen
#   is gated: any non-empty query redirects a signed-out visitor to /sign-in,
#   and the ordinary way to verify an address is to click a link in a mailed
#   message, which no laptop with no mail transport can do. So a developer who
#   ran only the migrations gets a working sign-in page and nothing behind it.
#
# WHERE THE DATABASE IS
#   The workspace's shared Postgres container, from ~/projects/docker-compose.yml,
#   published on host port 5433. This script does NOT start it: a compose file
#   shared by every project in the workspace is not this repo's to bring up or
#   tear down. It checks that the container is running and says how to start it.
#
# IT IS SAFE TO RUN TWICE. Every step is idempotent: the migrations skip what
# is applied, the dictionary restore truncates before it loads, and the account
# seed updates the row it finds. Re-run it whenever the local database drifts.
#
# Usage: scripts/stage-local.sh [--fresh]
#   --fresh  drop and recreate the database first, for a true clean slate.
set -euo pipefail

cd "$(dirname "$0")/.."

FRESH=0
if [ "${1:-}" = "--fresh" ]; then FRESH=1; shift; fi

if [ ! -f .env ]; then
  echo "error: no .env in $(pwd)" >&2
  echo "       copy .env.example to .env and set DB_PORT=5433 for the shared container." >&2
  exit 1
fi
# THE CALLER'S ENVIRONMENT WINS OVER .env. Sourcing with `set -a` overwrites
# what the caller exported, and this script can DROP a database, so a silently
# ignored DB_NAME is a destructive surprise. Captured first, put back after.
CALLER_DB_HOST="${DB_HOST:-}"; CALLER_DB_PORT="${DB_PORT:-}"
CALLER_DB_USER="${DB_USER:-}"; CALLER_DB_NAME="${DB_NAME:-}"
CALLER_DB_PASSWORD="${DB_PASSWORD:-}"
set -a; . ./.env; set +a
if [ -n "$CALLER_DB_HOST" ]; then DB_HOST="$CALLER_DB_HOST"; fi
if [ -n "$CALLER_DB_PORT" ]; then DB_PORT="$CALLER_DB_PORT"; fi
if [ -n "$CALLER_DB_USER" ]; then DB_USER="$CALLER_DB_USER"; fi
if [ -n "$CALLER_DB_NAME" ]; then DB_NAME="$CALLER_DB_NAME"; fi
if [ -n "$CALLER_DB_PASSWORD" ]; then DB_PASSWORD="$CALLER_DB_PASSWORD"; fi
# THREADED EXPLICITLY INTO THE TOOLBOX, BECAUSE `toolbox run` DOES NOT INHERIT
# THE SHELL ENVIRONMENT. Without this the psql steps below would honour a
# caller's DB_NAME while the migrations and the account seed quietly used the
# one in .env, which is two databases in one run. dotenv does not overwrite a
# variable that is already set, so what is passed here wins inside the container.
TB_ENV="DB_HOST=$DB_HOST DB_PORT=$DB_PORT DB_USER=$DB_USER DB_NAME=$DB_NAME DB_PASSWORD=$DB_PASSWORD CI=true"

DB_HOST="${DB_HOST:-localhost}"
DB_PORT="${DB_PORT:-5433}"
DB_USER="${DB_USER:-postgres}"
DB_NAME="${DB_NAME:-translate_altan_fyi}"
DB_PASSWORD="${DB_PASSWORD:-postgres}"
CONTAINER="${DICTIONARY_PG_CONTAINER:-projects-postgres-1}"

# The newest dump in the repo root, rather than a pinned filename: the seed is
# re-cut from time to time and a hardcoded date rots the moment it is.
SEED_DUMP="${SEED_DUMP:-$(ls -1t dictionary-seed-*.dump 2>/dev/null | head -1)}"

step() { printf '\n\033[1m==> %s\033[0m\n' "$1"; }

# ---------------------------------------------------------------------------
step "checking the shared Postgres container"
# ---------------------------------------------------------------------------
if ! docker inspect -f '{{.State.Running}}' "$CONTAINER" 2>/dev/null | grep -q true; then
  echo "error: container '$CONTAINER' is not running." >&2
  echo "       start it with: docker compose -f ~/projects/docker-compose.yml up -d" >&2
  exit 1
fi
echo "  $CONTAINER is up, host port $DB_PORT"

psql_postgres() {
  docker exec -e PGPASSWORD="$DB_PASSWORD" "$CONTAINER" \
    psql -v ON_ERROR_STOP=1 --username="$DB_USER" --dbname=postgres "$@"
}
psql_app() {
  docker exec -e PGPASSWORD="$DB_PASSWORD" "$CONTAINER" \
    psql -v ON_ERROR_STOP=1 --username="$DB_USER" --dbname="$DB_NAME" "$@"
}

# ---------------------------------------------------------------------------
step "the database"
# ---------------------------------------------------------------------------
if [ "$FRESH" = "1" ]; then
  echo "  --fresh drops the database $DB_NAME on $DB_HOST:$DB_PORT."
  if [ -t 0 ]; then
    printf '  type the database name to confirm: '
    read -r CONFIRM
    if [ "$CONFIRM" != "$DB_NAME" ]; then echo "  not confirmed, nothing dropped" >&2; exit 1; fi
  fi
  # Sessions are terminated first: DROP DATABASE fails while a dev server or a
  # worker still holds a pooled connection, and both are ordinary to have open.
  psql_postgres -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '$DB_NAME' AND pid <> pg_backend_pid();" >/dev/null
  psql_postgres -c "DROP DATABASE IF EXISTS $DB_NAME;"
fi
if psql_postgres -tAc "SELECT 1 FROM pg_database WHERE datname = '$DB_NAME';" | grep -q 1; then
  echo "  $DB_NAME exists"
else
  psql_postgres -c "CREATE DATABASE $DB_NAME;"
  echo "  created $DB_NAME"
fi

# ---------------------------------------------------------------------------
step "schema migrations"
# ---------------------------------------------------------------------------
# shellcheck disable=SC2086
toolbox run -c ts-dev env $TB_ENV pnpm drizzle:migrate

# ---------------------------------------------------------------------------
step "the dictionary"
# ---------------------------------------------------------------------------
# Counted rather than assumed. A migrated database is not an empty one here:
# migration 0007 seeds one `sources` row, so "did the restore run" cannot be
# answered by asking whether the table has anything in it. Headwords can.
HEADWORDS=$(psql_app -tAc "SELECT count(*) FROM headwords;" | tr -d '[:space:]')
if [ "$HEADWORDS" -gt 0 ]; then
  echo "  $HEADWORDS headwords already loaded, skipping the restore"
  echo "  (delete them, or pass --fresh, to reload from the dump)"
elif [ -z "$SEED_DUMP" ]; then
  echo "  no dictionary-seed-*.dump in the repo root, skipping" >&2
  echo "  the app will run, but every lookup will find nothing." >&2
else
  echo "  restoring $SEED_DUMP"
  DB_HOST="$DB_HOST" DB_PORT="$DB_PORT" DB_USER="$DB_USER" DB_NAME="$DB_NAME" \
    DB_PASSWORD="$DB_PASSWORD" scripts/dictionary-restore.sh --truncate-first "$SEED_DUMP"
fi

# ---------------------------------------------------------------------------
step "the developer account"
# ---------------------------------------------------------------------------
# shellcheck disable=SC2086
toolbox run -c ts-dev env $TB_ENV pnpm drizzle:seed

# ---------------------------------------------------------------------------
step "what is loaded"
# ---------------------------------------------------------------------------
psql_app -c "SELECT language_code AS lang, count(*) AS headwords FROM headwords GROUP BY 1 ORDER BY 2 DESC;"

printf '\n\033[1mReady.\033[0m Start the app with:\n\n    toolbox run -c ts-dev pnpm dev\n\n'
