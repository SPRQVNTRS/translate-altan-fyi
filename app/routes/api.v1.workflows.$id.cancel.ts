/**
 * POST /api/v1/workflows/:id/cancel
 * Body: { force?: boolean }
 *
 * Auth: Bearer token scoped to the workflow's org (or superadmin key).
 * Uses atomic UPDATE with disambiguation:
 *   - 0 rows updated → SELECT to determine 404 vs 409
 * Response: { workflow: Workflow }
 */

import type { Route } from './+types/api.v1.workflows.$id.cancel';
import {
  requireApiKey,
  assertOrgAccess,
  jsonError,
} from '#app/lib/api-auth.server';
import { getWorkflowById, cancelWorkflow, workflowOrgId } from '#app/models/workflows.server';

export async function loader(): Promise<Response> {
  throw jsonError(405, 'method not allowed');
}

export async function action({ request, params }: Route.ActionArgs): Promise<Response> {
  if (request.method !== 'POST') {
    throw jsonError(405, 'method not allowed');
  }

  const auth = await requireApiKey(request);

  const { id } = params;
  if (!id) throw jsonError(400, 'missing workflow id');

  // Auth check — fetch workflow first to get org context
  const workflow = await getWorkflowById(id);
  if (!workflow) throw jsonError(404, 'workflow not found');

  // Tenancy lives in the workflow's JSONB context — no context, no access.
  const orgId = workflowOrgId(workflow.context);
  if (orgId === null) {
    throw jsonError(403, 'access denied');
  }

  assertOrgAccess(auth, orgId);

  // Atomic cancel
  const result = await cancelWorkflow(id);

  if (result.kind === 'cancelled') {
    return new Response(JSON.stringify({ workflow: result.workflow }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  if (result.kind === 'notFound') {
    throw jsonError(404, 'workflow not found');
  }

  // notCancellable — workflow exists but is in a terminal state
  throw jsonError(409, 'workflow cannot be cancelled in its current state');
}
