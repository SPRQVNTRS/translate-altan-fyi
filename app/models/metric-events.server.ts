import type { InsertMetricEvent, SelectMetricEvent } from '#drizzle/schema';
import { metricEvents } from '#drizzle/schema';
import { tenantDb, getRawDb, asTenantRows, type TenantCtx } from '#drizzle/tenant-db';
import { eq, and, gte, lte, desc, count, type SQL } from 'drizzle-orm';
import type { PaginationParams } from '#app/lib/pagination.server';

export interface MetricEventFilters {
  eventType?: string;
  source?: string;
  from?: Date;
  to?: Date;
}

function buildWhereConditions(filters: MetricEventFilters): SQL | undefined {
  const conditions = [];
  if (filters.eventType) conditions.push(eq(metricEvents.eventType, filters.eventType));
  if (filters.source) conditions.push(eq(metricEvents.source, filters.source));
  if (filters.from) conditions.push(gte(metricEvents.timestamp, filters.from));
  if (filters.to) conditions.push(lte(metricEvents.timestamp, filters.to));
  return conditions.length > 0 ? and(...conditions) : undefined;
}

export async function insertMetricEvent(
  ctx: TenantCtx,
  data: Omit<InsertMetricEvent, 'organizationId'>,
): Promise<SelectMetricEvent> {
  const [result] = await tenantDb(ctx).insert(metricEvents, data).returning();
  if (!result) {
    throw new Error('Failed to insert metric event');
  }
  return result;
}

export async function insertMetricEvents(
  ctx: TenantCtx,
  data: Array<Omit<InsertMetricEvent, 'organizationId'>>,
): Promise<SelectMetricEvent[]> {
  if (data.length === 0) {
    return [];
  }
  return tenantDb(ctx).insertMany(metricEvents, data).returning();
}

export async function getMetricEvents(
  ctx: TenantCtx,
  filters: MetricEventFilters = {},
  pagination: PaginationParams = { limit: 20, offset: 0 },
): Promise<{ rows: SelectMetricEvent[]; total: number }> {
  const tdb = tenantDb(ctx);
  const extraWhere = buildWhereConditions(filters);
  const [rows, totalRow] = await Promise.all([
    tdb
      .select(metricEvents, extraWhere)
      .orderBy(desc(metricEvents.timestamp))
      .limit(pagination.limit)
      .offset(pagination.offset)
      .then((r) => asTenantRows(metricEvents, r)),
    getRawDb()
      .select({ value: count() })
      .from(metricEvents)
      .where(tdb.scope(metricEvents, extraWhere))
      .then((r) => r[0]),
  ]);
  return { rows, total: Number(totalRow?.value ?? 0) };
}
