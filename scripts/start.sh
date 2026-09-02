#!/bin/sh
set -e

echo "[start] Running schema migrations..."
pnpm drizzle:migrate

echo "[start] Running data migrations..."
pnpm cli data-migration run

# TWO PROCESSES IN ONE CONTAINER, ON PURPOSE.
#
# The enrichment workflow (M171/02) is a pg-boss job, and a queued job that
# nothing dequeues is a permanently pending entry page. `worker.ts` is what
# dequeues it. Bay runs ONE container for this service (group_vars/all/
# services.yml, `translate`), so the worker either shares this container or it
# does not run at all.
#
# WHY NOT `exec`. The old last line was `exec pnpm start`, which replaces this
# shell. A replaced shell cannot forward a signal to a second child and cannot
# notice one dying, so a backgrounded worker would be orphaned on every deploy
# and its shutdown would never be graceful. This supervisor keeps the shell
# alive instead.
#
# WHY A POLL AND NOT `wait -n`. The base image is alpine, so /bin/sh is BusyBox
# ash, where `wait -n` is not portable. The loop below is the POSIX equivalent:
# if either child stops existing, tear the other one down and exit non-zero so
# the container restarts as a unit. A half-dead container that still answers the
# healthcheck is the failure mode this exists to prevent.
term() {
  kill -TERM "$worker_pid" "$web_pid" 2>/dev/null || true
  wait "$worker_pid" 2>/dev/null || true
  wait "$web_pid" 2>/dev/null || true
}

echo "[start] Starting worker..."
pnpm worker &
worker_pid=$!

echo "[start] Starting server..."
pnpm start &
web_pid=$!

trap 'term; exit 0' TERM INT

while kill -0 "$worker_pid" 2>/dev/null && kill -0 "$web_pid" 2>/dev/null; do
  sleep 2
done

echo "[start] A child process exited, shutting the container down."
term
exit 1
