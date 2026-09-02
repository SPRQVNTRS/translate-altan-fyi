/**
 * GET /api/v1/workflows/:id/context
 *
 * Auth: Bearer token scoped to the workflow's org (or superadmin key).
 * Response: raw JSON context object (not wrapped in an envelope).
 */

import type { Route } from './+types/api.v1.workflows.$id.context';
import {
  requireApiKey,
  assertOrgAccess,
  jsonError,
} from '#app/lib/api-auth.server';
import { getWorkflowById, workflowOrgId } from '#app/models/workflows.server';

export async function loader({ request, params }: Route.LoaderArgs): Promise<Response> {
  const auth = await requireApiKey(request);

  const { id } = params;
  if (!id) throw jsonError(400, 'missing workflow id');

  const workflow = await getWorkflowById(id);
  if (!workflow) throw jsonError(404, 'workflow not found');

  // Tenancy lives in the workflow's JSONB context — no context, no access.
  const orgId = workflowOrgId(workflow.context);
  if (orgId === null) {
    throw jsonError(403, 'access denied');
  }

  assertOrgAccess(auth, orgId);

  // Return raw context — body IS the context object, not wrapped
  return new Response(JSON.stringify(workflow.context), {
    headers: { 'Content-Type': 'application/json' },
  });
}

export async function action(): Promise<Response> {
  throw jsonError(405, 'method not allowed');
}
