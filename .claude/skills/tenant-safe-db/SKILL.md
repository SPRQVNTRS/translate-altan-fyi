---
name: tenant-safe-db
description: Write database operations with proper tenant scoping using tenantDb(ctx). Use when performing database inserts, updates, deletes, or queries on tenant-scoped tables (articles, pages, categories, metricEvents, apiKeys, dataSources).
allowed-tools: Read, Write, Edit, Glob, Grep
---

# Tenant-Safe Database Operations

This skill ensures every database operation on a tenant-scoped table is correctly filtered by `organizationId`. There is **no Postgres RLS**; the wrapper API and code review are the entire defense.

## When Claude Should Use This Skill

- Writing inserts, updates, deletes, or queries against tenant-scoped tables
- Implementing route actions/loaders that read or write tenant data
- Creating workflow operations that persist data
- Adding new model functions

## The Two Tools

| Tool | When to use | Compile-time safety |
|---|---|---|
| `tenantDb(ctx)` | All single-table queries against tenant-scoped tables | Yes — `organizationId` is auto-filtered/stamped |
| `getRawDb()` | Global tables, cross-tenant lookups, joined SELECTs, migrations, seeds, tests | No — `.where(tdb.scope(table))` is the caller's job |

Both come from `#drizzle/tenant-db`.

## Tenant-Scoped Tables

These are the tables in `TENANT_TABLES` in `drizzle/tenant-db.ts`:

- `articles`
- `pages`
- `categories`
- `metricEvents`
- `apiKeys`
- `dataSources`

**Workflow tables** (`workflows`, `workflowOperations`, `workflowLocks`) come from `@sprqvntrs/workflows` and have **no `organizationId` column**. Tenant scope lives in the JSONB `context` field on each workflow — host code filters via `sql\`${workflows.context}->>'organizationId' = ${orgId}\``.

## Mandatory Patterns

### Pattern 1: Route Actions/Loaders

```typescript
import { tenantDb } from '#drizzle/tenant-db';
import { articles } from '#drizzle/schema';
import { getTenant } from '#app/middleware/tenant';
import { getUser } from '#app/middleware/helpers';

export async function action({ context }: Route.ActionArgs) {
  const tenant = getTenant(context);
  const user = getUser(context);

  // organizationId is auto-injected by the wrapper. DO NOT pass it.
  await tenantDb({ orgId: tenant.orgId }).insert(articles, {
    title,
    slug,
    content,
    authorId: user.id,
  });
}

export async function loader({ context, params }: Route.LoaderArgs) {
  const tenant = getTenant(context);
  const tdb = tenantDb({ orgId: tenant.orgId });

  // Simple select: pre-filtered by org.
  const list = await tdb.select(articles).orderBy(desc(articles.createdAt));

  // Find one within the tenant:
  const [article] = await tdb.select(articles, eq(articles.id, id)).limit(1);

  return { list, article };
}
```

### Pattern 2: Workflow Operations

Background jobs construct `ctx` from the workflow's input — there is no middleware to read it from.

```typescript
import { tenantDb } from '#drizzle/tenant-db';
import { articles } from '#drizzle/schema';

export const myHandler: OperationHandler = async (ctx) => {
  const input = ctx.initialContext as { organizationId: string; authorId: number };

  const [article] = await tenantDb({ orgId: input.organizationId })
    .insert(articles, { title, slug, content, authorId: input.authorId })
    .returning();
};
```

### Pattern 3: Model Functions

Models take a `TenantCtx` as their first parameter — they never reach into AsyncLocalStorage.

```typescript
import { tenantDb, type TenantCtx } from '#drizzle/tenant-db';
import { articles } from '#drizzle/schema';

export async function listArticles(ctx: TenantCtx) {
  return tenantDb(ctx).select(articles).orderBy(desc(articles.createdAt));
}

export async function deleteArticle(ctx: TenantCtx, id: number) {
  return tenantDb(ctx).delete(articles, eq(articles.id, id));
}
```

### Pattern 4: Joined Selects (use `getRawDb()` + `scope()`)

`tenantDb(ctx).select(table)` returns the Drizzle builder pre-filtered. For joined selects with custom field projections, Drizzle's `.where()` would *replace* the wrapper's filter — so use `getRawDb()` and the explicit `scope()` helper:

```typescript
import { tenantDb, getRawDb } from '#drizzle/tenant-db';
import { articles, users } from '#drizzle/schema';

const tdb = tenantDb({ orgId: tenant.orgId });
const rows = await getRawDb()
  .select({ id: articles.id, title: articles.title, authorName: users.name })
  .from(articles)
  .leftJoin(users, eq(articles.authorId, users.id))
  .where(tdb.scope(articles))           // ← REQUIRED. AND-able via tdb.scope(table, extra)
  .orderBy(desc(articles.createdAt));
```

### Pattern 5: Cross-Tenant Lookups (use `getRawDb()` directly)

Truly global operations — authenticating an API key by prefix (org unknown at auth time), resolving an org by slug, superadmin CLI commands — go straight through `getRawDb()`.

```typescript
import { getRawDb } from '#drizzle/tenant-db';
import { apiKeys, organizations } from '#drizzle/schema';

// Auth path — orgId not yet known
export async function verifyApiKey(rawKey: string) {
  return getRawDb()
    .select()
    .from(apiKeys)
    .where(and(eq(apiKeys.prefix, prefix), eq(apiKeys.hash, hash)))
    .limit(1);
}

// CLI org resolver
const org = await getRawDb().query.organizations.findFirst({
  where: eq(organizations.slug, slug),
});
```

## Anti-Patterns

### Direct `db` import from `#drizzle/db` (WRONG)

```typescript
import { db } from '#drizzle/db';     // ← FORBIDDEN in app code
await db.insert(articles).values({ organizationId, title });
```

Only `drizzle/tenant-db.ts`, migrations, and `drizzle/seed.ts` may import `db` from `#drizzle/db`. Everywhere else uses `getRawDb()` from `#drizzle/tenant-db` (loud name, grep-able).

### Passing `organizationId` to `tenantDb.insert` (WRONG)

```typescript
await tenantDb(ctx).insert(articles, { organizationId: tenant.orgId, title });
//                                   ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
//  Type error: 'organizationId' is omitted from the row type.
```

The wrapper stamps it for you. Passing it manually is a type error.

### `getRawDb()` against tenant tables without `.scope()` (WRONG)

```typescript
// Forgets the tenant filter — returns rows from EVERY org. No safety net.
await getRawDb().select().from(articles).orderBy(desc(articles.createdAt));
```

```typescript
// Correct — explicit org scope.
await getRawDb().select().from(articles).where(tdb.scope(articles)).orderBy(...);
```

### Chaining a second `.where()` on `tenantDb.select()` (WRONG)

```typescript
// Drizzle's .where() REPLACES, not ANDs. The wrapper's org filter is lost.
await tenantDb(ctx).select(articles).where(eq(articles.slug, 'foo'));
```

```typescript
// Correct — pass extra filters as the second arg, which is AND-ed in.
await tenantDb(ctx).select(articles, eq(articles.slug, 'foo'));
```

## When to Re-introduce RLS

The whole-app convention assumes the **application server** is the only writer to Postgres. If your fork:

- Exposes Postgres directly via PostgREST or Hasura
- Connects BI tools / analytics with shared credentials
- Lets customers run their own SQL (warehouses, embedded analytics)
- Plugs in an LLM agent that can write arbitrary SQL

…re-introduce RLS for those tables. The app-layer wrapper does not protect against actors that bypass it.

## Validation Before Submitting

- [ ] All tenant-scoped table queries go through `tenantDb(ctx)`, or through `getRawDb()` with an explicit `tdb.scope(table)` in the `where`.
- [ ] No `import { db } from '#drizzle/db'` in route, model, CLI, or workflow files.
- [ ] No `organizationId` passed manually to `tenantDb.insert()`.
- [ ] New tenant-scoped tables added to `TENANT_TABLES` in `drizzle/tenant-db.ts` AND have a NOT NULL `organizationId` column with an index.

## Reference Implementation

- Wrapper: `drizzle/tenant-db.ts`
- Model: `app/models/api-keys.server.ts`
- CLI: `cli/commands/api-key.ts`
