/**
 * GET /api/v1/orgs/:idOrSlug/members → { data: MemberWithUser[], total: number }
 *
 * Auth: superadmin API key only.
 */

import type { Route } from './+types/api.v1.orgs.$idOrSlug.members';
import { requireSuperadminApiKey, jsonError } from '#app/lib/api-auth.server';
import { getOrgByIdOrSlug, getOrgMembersAdmin } from '#app/models/orgs-admin.server';
import { parsePaginationParams, paginatedJson } from '#app/lib/pagination.server';

export async function loader({ request, params }: Route.LoaderArgs): Promise<Response> {
  await requireSuperadminApiKey(request);

  const { idOrSlug } = params;
  if (!idOrSlug) throw jsonError(400, 'missing idOrSlug');

  const org = await getOrgByIdOrSlug(idOrSlug);
  if (!org) throw jsonError(404, 'organization not found');

  const url = new URL(request.url);
  const pagination = parsePaginationParams(url.searchParams);
  const { rows, total } = await getOrgMembersAdmin(org.id, pagination);
  return paginatedJson({ data: rows, total, limit: pagination.limit, offset: pagination.offset });
}

export async function action(): Promise<Response> {
  throw jsonError(405, 'method not allowed');
}
