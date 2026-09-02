/**
 * GET /api/v1/users?limit=<n>&offset=<n>&active=true&deactivated=true&superadmin=true
 *
 * Auth: superadmin API key only.
 * Response: { data: SafeUser[], total: number }
 */

import type { Route } from './+types/api.v1.users';
import { requireSuperadminApiKey, jsonError } from '#app/lib/api-auth.server';
import { listUsersAdmin } from '#app/models/users-admin.server';
import { parsePaginationParams, paginatedJson } from '#app/lib/pagination.server';

export async function loader({ request }: Route.LoaderArgs): Promise<Response> {
  await requireSuperadminApiKey(request);

  const url = new URL(request.url);
  const active = url.searchParams.get('active') === 'true';
  const deactivated = url.searchParams.get('deactivated') === 'true';
  const superadmin = url.searchParams.get('superadmin') === 'true';

  const pagination = parsePaginationParams(url.searchParams);
  const { rows, total } = await listUsersAdmin(
    {
      active: active || undefined,
      deactivated: deactivated || undefined,
      superadmin: superadmin || undefined,
    },
    pagination,
  );

  return paginatedJson({ data: rows, total, limit: pagination.limit, offset: pagination.offset });
}

export async function action(): Promise<Response> {
  throw jsonError(405, 'method not allowed');
}
