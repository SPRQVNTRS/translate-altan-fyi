/**
 * GET /api/v1/workflows/:id?withOperations=true
 *
 * Auth: Bearer token scoped to the workflow's org (or superadmin key).
 * Response: { workflow: Workflow, operations?: WorkflowOperation[] }
 */

import type { Route } from './+types/api.v1.workflows.$id';
import {
  requireApiKey,
  assertOrgAccess,
  jsonError,
} from '#app/lib/api-auth.server';
import { getWorkflowById, listWorkflowOperations, workflowOrgId } from '#app/models/workflows.server';

export async function loader({ request, params }: Route.LoaderArgs): Promise<Response> {
  const auth = await requireApiKey(request);

  const { id } = params;
  if (!id) throw jsonError(400, 'missing workflow id');

  const workflow = await getWorkflowById(id);
  if (!workflow) throw jsonError(404, 'workflow not found');

  // Extract org from JSONB context — NULL → 403 (never leak existence)
  const orgId = workflowOrgId(workflow.context);
  if (orgId === null) {
    throw jsonError(403, 'access denied');
  }

  assertOrgAccess(auth, orgId);

  const url = new URL(request.url);
  const withOperations = url.searchParams.get('withOperations') === 'true';

  if (withOperations) {
    const { rows: operations } = await listWorkflowOperations(id, {});
    return new Response(JSON.stringify({ workflow, operations }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  return new Response(JSON.stringify({ workflow }), {
    headers: { 'Content-Type': 'application/json' },
  });
}

export async function action(): Promise<Response> {
  throw jsonError(405, 'method not allowed');
}
