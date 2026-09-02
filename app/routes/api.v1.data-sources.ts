/**
 * GET /api/v1/data-sources?org=<slug>  — List data sources for an org
 *
 * Auth: Bearer token (key must belong to org, or be superadmin).
 * Response: { data: SelectDataSource[], total: number }
 */

import type { Route } from './+types/api.v1.data-sources';
import {
  requireApiKey,
  assertOrgAccess,
  resolveOrgSlug,
} from '#app/lib/api-auth.server';
import { listDataSources } from '#app/models/data-sources.server';
import { parsePaginationParams, paginatedJson } from '#app/lib/pagination.server';

export async function loader({ request }: Route.LoaderArgs): Promise<Response> {
  const auth = await requireApiKey(request);

  const url = new URL(request.url);
  const orgId = await resolveOrgSlug(url.searchParams.get('org') ?? undefined);

  assertOrgAccess(auth, orgId);

  const pagination = parsePaginationParams(url.searchParams);
  const { rows, total } = await listDataSources(auth.ctx, pagination);
  return paginatedJson({ data: rows, total, limit: pagination.limit, offset: pagination.offset });
}
