/**
 * GET /api/v1/orgs?limit=<n>&offset=<n> → { data: SelectOrganization[], total: number }
 *
 * Auth: superadmin API key only.
 */

import type { Route } from './+types/api.v1.orgs';
import { requireSuperadminApiKey, jsonError } from '#app/lib/api-auth.server';
import { listOrgsAdmin } from '#app/models/orgs-admin.server';
import { parsePaginationParams, paginatedJson } from '#app/lib/pagination.server';

export async function loader({ request }: Route.LoaderArgs): Promise<Response> {
  await requireSuperadminApiKey(request);

  const url = new URL(request.url);
  const pagination = parsePaginationParams(url.searchParams);
  const { rows, total } = await listOrgsAdmin(pagination);
  return paginatedJson({ data: rows, total, limit: pagination.limit, offset: pagination.offset });
}

export async function action(): Promise<Response> {
  throw jsonError(405, 'method not allowed');
}
