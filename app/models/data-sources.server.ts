import { dataSources } from '#drizzle/schema';
import type { InsertDataSource, SelectDataSource } from '#drizzle/schema';
import { tenantDb, getRawDb, asTenantRow, asTenantRows, type TenantCtx } from '#drizzle/tenant-db';
import { eq, desc, count } from 'drizzle-orm';
import type { PaginationParams } from '#app/lib/pagination.server';

/** List all data sources for the current org, paginated. */
export async function listDataSources(
  ctx: TenantCtx,
  pagination: PaginationParams = { limit: 20, offset: 0 },
): Promise<{ rows: SelectDataSource[]; total: number }> {
  const tdb = tenantDb(ctx);
  const [rows, totalRow] = await Promise.all([
    tdb
      .select(dataSources)
      .orderBy(desc(dataSources.createdAt))
      .limit(pagination.limit)
      .offset(pagination.offset)
      .then((r) => asTenantRows(dataSources, r)),
    getRawDb()
      .select({ value: count() })
      .from(dataSources)
      .where(tdb.scope(dataSources))
      .then((r) => r[0]),
  ]);
  return { rows, total: Number(totalRow?.value ?? 0) };
}

/** Get a single data source by ID within the org, or null. */
export async function getDataSourceById(ctx: TenantCtx, id: string): Promise<SelectDataSource | null> {
  const [result] = await tenantDb(ctx).select(dataSources, eq(dataSources.id, id)).limit(1);
  return asTenantRow(dataSources, result);
}

/** Create a new data source for the current org. */
export async function createDataSource(
  ctx: TenantCtx,
  data: Omit<InsertDataSource, 'organizationId'>,
): Promise<SelectDataSource> {
  const [result] = await tenantDb(ctx).insert(dataSources, data).returning();
  if (!result) {
    throw new Error('Failed to create data source');
  }
  return result;
}

/** Update a data source within the org. Returns null if id is not in this org. */
export async function updateDataSource(
  ctx: TenantCtx,
  id: string,
  data: Partial<
    Pick<InsertDataSource, 'name' | 'slug' | 'type' | 'config' | 'schedule' | 'mapping' | 'enabled'>
  >,
): Promise<SelectDataSource | null> {
  const [result] = await tenantDb(ctx).update(dataSources, eq(dataSources.id, id), data).returning();
  return result ?? null;
}

/** Delete a data source within the org. */
export async function deleteDataSource(ctx: TenantCtx, id: string): Promise<void> {
  await tenantDb(ctx).delete(dataSources, eq(dataSources.id, id));
}

/** Toggle enabled status. */
export async function toggleDataSource(
  ctx: TenantCtx,
  id: string,
  enabled: boolean,
): Promise<SelectDataSource | null> {
  const [result] = await tenantDb(ctx)
    .update(dataSources, eq(dataSources.id, id), { enabled })
    .returning();
  return result ?? null;
}

/** Update fetch status (called after a fetch attempt). */
export async function updateFetchStatus(
  ctx: TenantCtx,
  id: string,
  status: { lastFetchedAt: Date; lastError: string | null },
): Promise<void> {
  await tenantDb(ctx).update(dataSources, eq(dataSources.id, id), status);
}
