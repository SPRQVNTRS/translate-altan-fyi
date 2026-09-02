/**
 * GET /api/v1/workflows/stats?org=<slug>
 *
 * Auth:
 *   - With ?org=<slug>: Bearer token scoped to that org (or superadmin key). assertOrgAccess enforced.
 *   - Without ?org, org-scoped key: defaults to the key's own org.
 *   - Without ?org, superadmin key: global view (no org filter).
 *
 * Response: { total: number, byStatus: Record<string, number>, byType: Record<string, number> }
 */

import type { Route } from './+types/api.v1.workflows.stats';
import {
  requireApiKey,
  resolveOrgSlug,
  assertOrgAccess,
  jsonError,
} from '#app/lib/api-auth.server';
import { getWorkflowStats } from '#app/models/workflows.server';

export async function loader({ request }: Route.LoaderArgs): Promise<Response> {
  const auth = await requireApiKey(request);

  const url = new URL(request.url);
  const orgSlug = url.searchParams.get('org') ?? undefined;

  let orgId: string | undefined;

  if (orgSlug) {
    orgId = await resolveOrgSlug(orgSlug);
    assertOrgAccess(auth, orgId);
  } else if (!auth.isSuperadmin) {
    // Org-scoped key with no org param → default to the key's org
    orgId = auth.apiKey.organizationId;
  }
  // Superadmin + no org → global view

  const stats = await getWorkflowStats(orgId);

  return new Response(JSON.stringify(stats), {
    headers: { 'Content-Type': 'application/json' },
  });
}

export async function action(): Promise<Response> {
  throw jsonError(405, 'method not allowed');
}
