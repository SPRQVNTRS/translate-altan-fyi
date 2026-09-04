---
name: getrawdb-is-the-only-handle
description: drizzle/tenant-db.ts is gone; getRawDb lives in drizzle/db.ts and is a plain alias for db, and apiKeys carries its own isSuperadmin
metadata:
  type: project
---

`drizzle/tenant-db.ts` no longer exists. M189 dropped the eight inherited
ts-factory-stack tables (`organizations`, `organization_members`, `users`,
`articles`, `categories`, `pages`, `metric_events`, `data_sources`), which
emptied `TENANT_TABLES` and left the wrapper scoping to nothing.

**Why:** the audit found zero rows in every one of them on production, and no
product route reached them. See ADR-0010 and migrations `0014_cool_reavers`
(the `api_keys` reshape) and `0015_long_stingray` (the eight drops).

**How to apply:**

- `getRawDb()` now lives in `drizzle/db.ts` and returns `db`. It survives as a
  name only, so ~30 call sites did not have to be rewritten. Either import is
  correct; do not "clean up" one into the other in passing.
- There is no `tenantDb`, `TenantCtx`, `asTenantRow`, `asTenantRows`,
  `assertOrgAccess` or `resolveOrgSlug`. A comment that still mentions
  `TENANT_TABLES` or `tenantDb` is stale prose, not a live contract.
- `apiKeys` is flat: `id`, `name`, `prefix`, `hash`, `isSuperadmin`,
  `lastUsedAt`, `expiresAt`, `revoked`, `createdAt`. `requireSuperadminApiKey`
  reads `apiKey.isSuperadmin` with no join. The SCREEN-level flag is a
  different one, `accounts.is_superadmin`, and neither reads the other.
- `pnpm cli api-key create --name <n> [--superadmin]`. There is no `--org`.

Related: [[project_drizzle_kit_cannot_change_a_column_type]],
[[project_drizzle_generate_needs_a_pty]]
