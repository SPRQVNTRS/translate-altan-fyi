/**
 * GET /api/v1/workflows?org=<slug>&status=<s>&type=<t>&limit=<n>&offset=<n>
 *
 * Auth:
 *   - With ?org=<slug>: Bearer token scoped to that org (or superadmin key). assertOrgAccess enforced.
 *   - Without ?org, org-scoped key: defaults to the key's own org.
 *   - Without ?org, superadmin key: global view (no org filter).
 *
 * Response: { data: Workflow[], total: number }
 */

import type { Route } from './+types/api.v1.workflows';
import {
  requireApiKey,
  resolveOrgSlug,
  assertOrgAccess,
  jsonError,
} from '#app/lib/api-auth.server';
import { listWorkflows } from '#app/models/workflows.server';
import { parsePaginationParams, paginatedJson } from '#app/lib/pagination.server';

export async function loader({ request }: Route.LoaderArgs): Promise<Response> {
  const auth = await requireApiKey(request);

  const url = new URL(request.url);
  const orgSlug = url.searchParams.get('org') ?? undefined;
  const status = url.searchParams.get('status') ?? undefined;
  const type = url.searchParams.get('type') ?? undefined;

  const pagination = parsePaginationParams(url.searchParams);

  let orgId: string | undefined;

  if (orgSlug) {
    // Explicit org param — resolve slug and enforce access
    orgId = await resolveOrgSlug(orgSlug);
    assertOrgAccess(auth, orgId);
  } else if (!auth.isSuperadmin) {
    // Org-scoped key with no org param → default to the key's org
    orgId = auth.apiKey.organizationId;
  }
  // Superadmin key + no org param → orgId stays undefined → global view

  const { rows, total } = await listWorkflows({ orgId, status, type }, pagination);
  return paginatedJson({ data: rows, total, limit: pagination.limit, offset: pagination.offset });
}

export async function action(): Promise<Response> {
  throw jsonError(405, 'method not allowed');
}
