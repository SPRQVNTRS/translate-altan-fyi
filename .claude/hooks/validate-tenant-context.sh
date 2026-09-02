#!/bin/bash
# Hook: Validate tenant-safe DB usage after Write/Edit.
#
# Reminds Claude when an app-code file imports `db` directly from #drizzle/db,
# or uses the dead `getDb()` / `withTenantContext()` API. The new pattern is
# `tenantDb(ctx)` and `getRawDb()` from #drizzle/tenant-db.

INPUT=$(cat)
FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty')

if [[ -z "$FILE_PATH" ]]; then
  echo '{"continue": true}'
  exit 0
fi

# Only check app/CLI code, not the wrapper itself, migrations, seeds, or tests.
if [[ ! "$FILE_PATH" =~ (app/routes|app/models|app/workflows|app/services|cli/) ]]; then
  echo '{"continue": true}'
  exit 0
fi

if [[ "$FILE_PATH" == *"tenant-db.ts"* || "$FILE_PATH" == *"drizzle/seed.ts"* ]]; then
  echo '{"continue": true}'
  exit 0
fi

if [[ "$FILE_PATH" =~ \.(test|spec)\.(ts|tsx)$ ]]; then
  echo '{"continue": true}'
  exit 0
fi

if [[ ! -f "$FILE_PATH" ]]; then
  echo '{"continue": true}'
  exit 0
fi

# Hard reminder: direct `db` import from #drizzle/db in app code.
HAS_DIRECT_DB=$(grep -E "from ['\"]#drizzle/db['\"]" "$FILE_PATH" 2>/dev/null | head -1)
if [[ -n "$HAS_DIRECT_DB" ]]; then
  echo '{"continue": true, "systemMessage": "⚠️ TENANT SAFETY: This file imports db from #drizzle/db. Replace with `import { tenantDb, getRawDb } from '\''#drizzle/tenant-db'\''`. Tenant-scoped tables go through tenantDb(ctx); global tables / cross-tenant lookups use getRawDb(). See .claude/skills/tenant-safe-db/SKILL.md."}'
  exit 0
fi

# Soft warning: stale RLS-era API references that no longer exist.
HAS_DEAD_API=$(grep -E "withTenantContext|withCurrentTenantContext|withoutTenantContext|\bgetDb\(" "$FILE_PATH" 2>/dev/null | head -1)
if [[ -n "$HAS_DEAD_API" ]]; then
  echo '{"continue": true, "systemMessage": "⚠️ TENANT SAFETY: This file uses the old RLS-era API (withTenantContext / getDb()). That API was removed — use tenantDb(ctx) and getRawDb() from #drizzle/tenant-db instead. See .claude/skills/tenant-safe-db/SKILL.md."}'
  exit 0
fi

# Bypass-class check: file uses getRawDb() AND imports a tenant table from schema,
# but doesn't reference tdb.scope(table). Catches "I used getRawDb() and forgot
# to add .where(tdb.scope(table))" against a tenant-scoped table.
HAS_RAW_DB=$(grep -E "\bgetRawDb\(" "$FILE_PATH" 2>/dev/null | head -1)
if [[ -n "$HAS_RAW_DB" ]]; then
  HAS_TENANT_TABLE_IMPORT=$(grep -E "from ['\"]#drizzle/schema['\"]" "$FILE_PATH" 2>/dev/null \
    | grep -oE "(apiKeys|articles|categories|dataSources|metricEvents|pages)" \
    | head -1)
  HAS_SCOPE=$(grep -E "\.scope\(" "$FILE_PATH" 2>/dev/null | head -1)
  if [[ -n "$HAS_TENANT_TABLE_IMPORT" && -z "$HAS_SCOPE" ]]; then
    echo '{"continue": true, "systemMessage": "⚠️ TENANT SAFETY: This file uses getRawDb() AND imports a tenant-scoped table (apiKeys/articles/categories/dataSources/metricEvents/pages), but no `.scope(` call appears. Any read/write against a tenant table via getRawDb() MUST include `.where(tdb.scope(table))`. See .claude/skills/tenant-safe-db/SKILL.md."}'
    exit 0
  fi
fi

# Anti-footgun: .where() chained on tenantDb(...).select(...) replaces the org filter.
HAS_TENANTDB_WHERE_CHAIN=$(grep -nE "tenantDb\([^)]*\)\.select\([^)]+\)" "$FILE_PATH" 2>/dev/null | head -1)
if [[ -n "$HAS_TENANTDB_WHERE_CHAIN" ]]; then
  # Look for the same line OR the next 5 lines containing `.where(`
  if grep -PzoE "tenantDb\([^)]*\)\.select\([^)]+\)(\s|\.[a-zA-Z]+\([^)]*\)){0,5}\s*\.where\(" "$FILE_PATH" >/dev/null 2>&1; then
    echo '{"continue": true, "systemMessage": "⚠️ TENANT SAFETY: Chaining `.where(...)` on `tenantDb(ctx).select(table)` REPLACES the org filter (Drizzle .where is single-call, not AND). Pass extra conditions as the second arg: `tenantDb(ctx).select(table, eq(...))`. See .claude/skills/tenant-safe-db/SKILL.md."}'
    exit 0
  fi
fi

echo '{"continue": true}'
exit 0
