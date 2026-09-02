/**
 * GET  /api/v1/api-keys?org=<slug>  — List API keys for an org
 * POST /api/v1/api-keys             — Create a new API key
 *
 * Auth: Bearer token (the calling key must belong to the org, or be superadmin).
 */

import { z } from 'zod';
import type { Route } from './+types/api.v1.api-keys';
import {
  requireApiKey,
  assertOrgAccess,
  resolveOrgSlug,
  jsonError,
  parseJsonBody,
} from '#app/lib/api-auth.server';
import { listApiKeys, createApiKey } from '#app/models/api-keys.server';
import { parsePaginationParams, paginatedJson } from '#app/lib/pagination.server';

/** Body accepted by `POST /api/v1/api-keys`. */
const createApiKeyBodySchema = z.object({
  org: z.string(),
  name: z.string(),
});

export async function loader({ request }: Route.LoaderArgs): Promise<Response> {
  const auth = await requireApiKey(request);

  const url = new URL(request.url);
  const orgId = await resolveOrgSlug(url.searchParams.get('org') ?? undefined);

  assertOrgAccess(auth, orgId);

  const pagination = parsePaginationParams(url.searchParams);
  const { rows, total } = await listApiKeys(auth.ctx, pagination);
  return paginatedJson({ data: rows, total, limit: pagination.limit, offset: pagination.offset });
}

export async function action({ request }: Route.ActionArgs): Promise<Response> {
  if (request.method !== 'POST') {
    throw jsonError(405, 'method not allowed');
  }

  const auth = await requireApiKey(request);

  const { org, name } = await parseJsonBody(request, createApiKeyBodySchema);
  const orgId = await resolveOrgSlug(org);

  assertOrgAccess(auth, orgId);

  const { key, record } = await createApiKey(auth.ctx, {
    name,
    createdBy: auth.apiKey.createdBy ?? null,
  });

  return new Response(JSON.stringify({ key, record }), {
    status: 201,
    headers: { 'Content-Type': 'application/json' },
  });
}
