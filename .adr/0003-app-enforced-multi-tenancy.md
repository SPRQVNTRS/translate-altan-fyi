# 0003 — App-enforced multi-tenancy (no RLS)

> **Superseded by [0010](0010-drop-the-inherited-tenancy.md), 2026-09-04.** The
> tenancy this record describes was inherited from `ts-factory-stack` and never
> had a tenant: `organizations`, `organizationMembers` and `users` all held zero
> rows in production. `tenantDb` and every table it scoped are deleted. Read
> this record for the history of the choice, not for how the code works today.

- **Status:** Superseded
- **Date:** 2026-05-13
- **Deciders:** Altan

## Context

The stack used to enforce tenant isolation via Postgres Row-Level Security (RLS), setting `app.current_org_id` per request and letting Postgres scope every query. RLS is robust against bypass at the DB layer, but it carries real costs:

- Every connection has to be in the right session state; pool checkout/return becomes a footgun.
- Migrations and admin tooling have to constantly toggle RLS on/off.
- Errors when policies don't match a query shape are opaque ("no rows returned" instead of a clear validation error).
- Drizzle's typed query builder loses some of its appeal when half the filtering happens invisibly in the DB.

Since the application server is the only writer to this DB, the marginal safety RLS adds over a well-designed app-layer wrapper is small relative to the operational pain.

## Decision

**Tenant isolation is enforced in application code via `tenantDb(ctx)` from `drizzle/tenant-db.ts`.** Postgres RLS is not used.

- Tenant-scoped tables (`articles`, `pages`, `categories`, `metricEvents`, `apiKeys`, `dataSources`) are only accessed via `tenantDb({ orgId })`, which auto-injects the `organization_id` filter on every read and write.
- Global tables (`users`, `organizations`, `organizationMembers`) and cross-tenant lookups use the explicitly-named `getRawDb()`.
- Complex joins use `getRawDb() + tdb.scope(table)` to opt into scoping while keeping Drizzle's full query surface.
- Code review and the wrapper's API surface are the entire defense — there is no DB-level safety net.

## Alternatives Considered

- **Keep RLS.** Strong safety, but operational drag described in Context. Rejected for now.
- **Hybrid: RLS for tenant tables, app code everywhere else.** Worst of both worlds — still have the operational complexity, still need the wrapper for ergonomics.
- **Postgres schemas per tenant.** Doesn't scale beyond hundreds of tenants; migration story is awful.

## Consequences

**Good:**
- Simpler ops: any Drizzle connection works; no per-request session state required.
- Migrations and admin tools don't need RLS exemptions.
- Clearer errors when tenant scoping is wrong — they surface in app code, not as silent empty result sets.
- `getRawDb()` is deliberately ugly to grep for, making review easy.

**Bad / cost:**
- A bug that uses `getRawDb()` directly against a tenant-scoped table without `tdb.scope(...)` can leak across tenants. Mitigation: explicit naming, code review, and avoiding `getRawDb()` outside of well-known query patterns.
- If anything other than this server ever writes to the DB — BI tools, PostgREST/Hasura, customer-facing SQL analytics, LLM agents writing raw SQL — RLS must be reintroduced before that lands.

## References

- `drizzle/tenant-db.ts` — the wrapper
- `.claude/skills/tenant-safe-db/SKILL.md` — usage patterns
- AGENTS.md — the two-rule summary for daily work
