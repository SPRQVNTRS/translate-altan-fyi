/**
 * GET /api/v1/metric-events?org=<slug>&source=<s>&type=<t>&limit=<n>&offset=<n>
 *
 * Auth:
 *   - With ?org=<slug>: Bearer token scoped to that org (or superadmin key).
 *   - Without ?org:     Superadmin Bearer token required — returns global view.
 *
 * Response: { data: SelectMetricEvent[], total: number }
 */

import type { Route } from './+types/api.v1.metric-events';
import {
  requireApiKey,
  requireSuperadminApiKey,
  assertOrgAccess,
  resolveOrgSlug,
} from '#app/lib/api-auth.server';
import { getMetricEvents } from '#app/models/metric-events.server';
import { metricEvents } from '#drizzle/schema';
import { getRawDb } from '#drizzle/tenant-db';
import { eq, and, desc, count, type SQL } from 'drizzle-orm';
import { parsePaginationParams, paginatedJson } from '#app/lib/pagination.server';

export async function loader({ request }: Route.LoaderArgs): Promise<Response> {
  const url = new URL(request.url);
  const orgSlug = url.searchParams.get('org') ?? undefined;
  const source = url.searchParams.get('source') ?? undefined;
  const type = url.searchParams.get('type') ?? undefined;

  const pagination = parsePaginationParams(url.searchParams);

  if (orgSlug) {
    // Org-scoped path — regular API key or superadmin key both work
    const auth = await requireApiKey(request);
    const orgId = await resolveOrgSlug(orgSlug);
    assertOrgAccess(auth, orgId);
    const { rows, total } = await getMetricEvents(auth.ctx, { source, eventType: type }, pagination);
    return paginatedJson({ data: rows, total, limit: pagination.limit, offset: pagination.offset });
  }

  // Global path — superadmin key required
  await requireSuperadminApiKey(request);
  const conditions: SQL[] = [];
  if (source) conditions.push(eq(metricEvents.source, source));
  if (type) conditions.push(eq(metricEvents.eventType, type));
  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const [rows, totalRow] = await Promise.all([
    getRawDb()
      .select()
      .from(metricEvents)
      .where(where)
      .orderBy(desc(metricEvents.timestamp))
      .limit(pagination.limit)
      .offset(pagination.offset),
    getRawDb()
      .select({ value: count() })
      .from(metricEvents)
      .where(where)
      .then((r) => r[0]),
  ]);
  const total = Number(totalRow?.value ?? 0);
  return paginatedJson({ data: rows, total, limit: pagination.limit, offset: pagination.offset });
}
