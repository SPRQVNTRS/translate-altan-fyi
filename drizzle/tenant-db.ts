import { and, eq, type SQL } from 'drizzle-orm';
import type { PgTable } from 'drizzle-orm/pg-core';
import { db } from './db';
import {
  apiKeys,
  articles,
  categories,
  dataSources,
  metricEvents,
  pages,
} from './schema';

/**
 * Tenant-scoped tables — every table here has a NOT NULL `organizationId` column.
 * Adding a new tenant table = add it here AND give it an `organizationId` column.
 *
 * Workflow tables (workflows, workflowOperations, workflowLocks) come from
 * `@sprqvntrs/workflows` and have NO `organizationId`. They are intentionally
 * NOT in this set — filter them yourself via the JSONB `context` field, or use
 * `getRawDb()` if you genuinely need cross-tenant access.
 */
export const TENANT_TABLES = {
  apiKeys,
  articles,
  categories,
  dataSources,
  metricEvents,
  pages,
} as const;

export type TenantTable = (typeof TENANT_TABLES)[keyof typeof TENANT_TABLES];

export interface TenantCtx {
  orgId: string;
}

/**
 * Returns the underlying Drizzle instance with full access to every table,
 * including tenant-scoped ones. Use ONLY for:
 *   - Global tables (users, organizations, organization_members)
 *   - Workflow tables (no organizationId, filter via context JSONB)
 *   - Cross-tenant lookups (e.g. verifying an API key by prefix)
 *   - Migrations, seeds, tests
 *
 * NEVER use this to query tenant tables on behalf of a logged-in user.
 * Use `tenantDb(ctx)` instead.
 */
export function getRawDb() {
  return db;
}

/**
 * Build a tenant-scoped query builder.
 *
 * Every operation on a tenant table is automatically scoped to `ctx.orgId`:
 *   - `select` prepends `WHERE organization_id = ctx.orgId [AND <extra>]`
 *   - `insert` overwrites the row's `organizationId` with `ctx.orgId`
 *   - `update` / `delete` AND the user's where clause with the org filter
 *
 * For complex joined selects with custom field projections, use:
 *
 *     const tdb = tenantDb(ctx);
 *     await getRawDb()
 *       .select({ id: articles.id, authorName: users.name })
 *       .from(articles)
 *       .leftJoin(users, eq(articles.authorId, users.id))
 *       .where(tdb.scope(articles))
 *       .orderBy(desc(articles.createdAt));
 *
 * The `tdb.scope(table)` helper returns the org filter SQL — code review must
 * ensure it is present on every getRawDb() call that touches a tenant table.
 */
export function tenantDb(ctx: TenantCtx) {
  return new TenantDb(ctx);
}

export class TenantDb {
  constructor(private readonly ctx: TenantCtx) {}

  get orgId(): string {
    return this.ctx.orgId;
  }

  /** Compose `eq(table.organizationId, ctx.orgId)` AND-ed with an optional extra filter. */
  scope<T extends TenantTable>(table: T, extra?: SQL): SQL {
    const orgCond = eq(table.organizationId, this.ctx.orgId);
    if (!extra) return orgCond;
    const combined = and(orgCond, extra);
    if (!combined) throw new Error('Failed to compose tenant scope');
    return combined;
  }

  /**
   * SELECT * FROM <table> WHERE organization_id = ctx.orgId [AND <extraWhere>].
   * Chainable for `.orderBy()`, `.limit()`, `.offset()` etc.
   *
   * To filter on more columns, pass them as `extraWhere` — chaining a second
   * `.where()` on the returned builder would replace the org filter.
   */
  select<T extends TenantTable>(table: T, extraWhere?: SQL) {
    // SAFETY: the widened table is the same value the caller passed, so the
    // query still reads exactly `T`. Drizzle's `.from()` overload guards its
    // argument with a `TableLikeHasEmptySelection<T>` conditional that cannot
    // be resolved against an unresolved generic, so `T` is widened to the base
    // `PgTable` here. Callers restore the concrete row type at their own
    // boundary; see the model functions in `app/models/*.server.ts`.
    return db
      .select()
      .from(table as PgTable)
      .where(this.scope(table, extraWhere))
      .$dynamic();
  }


  /**
   * INSERT INTO <table> VALUES (..., organization_id = ctx.orgId).
   * Caller MUST NOT pass `organizationId` — the wrapper sets it.
   */
  insert<T extends TenantTable>(table: T, row: Omit<T['$inferInsert'], 'organizationId'>) {
    const stamped = { ...row, organizationId: this.ctx.orgId };
    // SAFETY: `stamped` is `Omit<T['$inferInsert'], 'organizationId'>` plus the
    // `organizationId` this wrapper owns — i.e. exactly `T['$inferInsert']`.
    // `.values()` narrows against the concrete table type Drizzle infers from
    // its own argument and cannot see through our `T extends TenantTable`
    // constraint, so `never` is the only type it accepts from a generic caller.
    return db.insert(table).values(stamped as never);
  }

  /** Same as `insert` but for multiple rows. */
  insertMany<T extends TenantTable>(
    table: T,
    rows: Array<Omit<T['$inferInsert'], 'organizationId'>>,
  ) {
    const stamped = rows.map((r) => ({ ...r, organizationId: this.ctx.orgId }));
    // SAFETY: same invariant as `insert` above, one row at a time.
    return db.insert(table).values(stamped as never);
  }

  /**
   * UPDATE <table> SET <values> WHERE organization_id = ctx.orgId AND <where>.
   * The org filter is always AND-ed in; cross-tenant writes are impossible
   * through this method.
   *
   * `organizationId` is BANNED from the values payload at both the type level
   * (`Omit`) and at runtime (stripped before SET) so a caller can't move a row
   * to another tenant via UPDATE SET organization_id = ....
   */
  update<T extends TenantTable>(
    table: T,
    where: SQL,
    values: Omit<Partial<T['$inferInsert']>, 'organizationId'>,
  ) {
    // Defensive runtime strip — guards against `values as any` callers and
    // `Partial<...>`-typed variables that may have been spread in from forms.
    // SAFETY: the assertion only re-admits the `organizationId` key that the
    // parameter type already forbids, so the destructuring can strip it at
    // runtime too. It widens nothing else: every other key is unchanged.
    const { organizationId: _stripped, ...safe } = values as Partial<T['$inferInsert']> & {
      organizationId?: string;
    };
    void _stripped;
    // SAFETY: `safe` is `Partial<T['$inferInsert']>` minus `organizationId`,
    // which is what `.set()` accepts. As with `insert`, Drizzle cannot narrow
    // against our generic constraint, so `never` is the only accepted type.
    return db
      .update(table)
      .set(safe as never)
      .where(this.scope(table, where));
  }

  /** DELETE FROM <table> WHERE organization_id = ctx.orgId AND <where>. */
  delete<T extends TenantTable>(table: T, where: SQL) {
    return db.delete(table).where(this.scope(table, where));
  }
}

/**
 * Name the concrete row type on rows read through `TenantDb.select`.
 *
 * `select` widens its table to the base `PgTable` to get past a Drizzle
 * overload guard (see the SAFETY note there), which erases the row type. Models
 * call this at their own boundary so their public signatures return the real
 * `Select*` type instead of an anonymous record.
 */
export function asTenantRows<T extends TenantTable, TRow extends object>(
  table: T,
  rows: TRow[],
): Array<T['$inferSelect']> {
  void table;
  // SAFETY: `table` is the table the caller passed to `select`, and `select`
  // reads it with no projection, so every row is a full `T['$inferSelect']`.
  // This undoes Drizzle's erasure and widens nothing.
  return rows as Array<T['$inferSelect']>;
}

/** Single-row form of {@link asTenantRows}; `undefined` when the query found nothing. */
export function asTenantRow<T extends TenantTable, TRow extends object>(
  table: T,
  row: TRow | undefined,
): T['$inferSelect'] | null {
  return row === undefined ? null : (asTenantRows(table, [row])[0] ?? null);
}
