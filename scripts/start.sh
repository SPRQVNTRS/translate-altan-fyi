#!/bin/sh
set -e

echo "[start] Running schema migrations..."
pnpm drizzle:migrate

echo "[start] Running data migrations..."
pnpm cli data-migration run

echo "[start] Starting server..."
exec pnpm start
