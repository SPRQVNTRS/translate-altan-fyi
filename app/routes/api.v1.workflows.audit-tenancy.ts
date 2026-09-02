/**
 * GET /api/v1/workflows/audit-tenancy
 *
 * Auth: superadmin API key ONLY.
 * Response: { totals: Array<{ organizationId: string|null, count: number }>, missing: number, orphans: string[] }
 *
 * CRITICAL: Uses getRawDb() via the model — intentional cross-tenant admin query.
 * Do NOT use tenantDb() here.
 */

import type { Route } from './+types/api.v1.workflows.audit-tenancy';
import {
  requireSuperadminApiKey,
  jsonError,
} from '#app/lib/api-auth.server';
import { auditWorkflowTenancy } from '#app/models/workflows.server';

export async function loader({ request }: Route.LoaderArgs): Promise<Response> {
  await requireSuperadminApiKey(request);

  const result = await auditWorkflowTenancy();

  return new Response(JSON.stringify(result), {
    headers: { 'Content-Type': 'application/json' },
  });
}

export async function action(): Promise<Response> {
  throw jsonError(405, 'method not allowed');
}
