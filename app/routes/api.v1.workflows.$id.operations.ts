/**
 * GET /api/v1/workflows/:id/operations?status=<s>
 *
 * Auth: Bearer token scoped to the workflow's org (or superadmin key).
 * Response: { data: WorkflowOperation[], total: number }
 */

import type { Route } from './+types/api.v1.workflows.$id.operations';
import {
  requireApiKey,
  assertOrgAccess,
  jsonError,
} from '#app/lib/api-auth.server';
import { getWorkflowById, listWorkflowOperations, workflowOrgId } from '#app/models/workflows.server';
import { parsePaginationParams, paginatedJson } from '#app/lib/pagination.server';

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

  const url = new URL(request.url);
  const status = url.searchParams.get('status') ?? undefined;

  const pagination = parsePaginationParams(url.searchParams);
  const { rows, total } = await listWorkflowOperations(id, { status }, pagination);
  return paginatedJson({ data: rows, total, limit: pagination.limit, offset: pagination.offset });
}

export async function action(): Promise<Response> {
  throw jsonError(405, 'method not allowed');
}
