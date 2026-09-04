/**
 * GET  /api/v1/api-keys  — List the API keys on this installation
 * POST /api/v1/api-keys  — Mint a new API key
 *
 * Auth: a superadmin Bearer token. There is no org to scope a listing to any
 * more, so a listing is the whole set, and handing that to an ordinary key
 * would tell every caller which other keys exist.
 */

import { z } from 'zod';
import type { Route } from './+types/api.v1.api-keys';
import {
  requireSuperadminApiKey,
  jsonError,
  parseJsonBody,
} from '#app/lib/api-auth.server';
import { listApiKeys, createApiKey } from '#app/models/api-keys.server';
import { parsePaginationParams, paginatedJson } from '#app/lib/pagination.server';

/** Body accepted by `POST /api/v1/api-keys`. */
const createApiKeyBodySchema = z.object({
  name: z.string(),
  /** Absent means an ordinary key. Granting authority has to be said. */
  isSuperadmin: z.boolean().default(false),
});

export async function loader({ request }: Route.LoaderArgs): Promise<Response> {
  await requireSuperadminApiKey(request);

  const url = new URL(request.url);
  const pagination = parsePaginationParams(url.searchParams);
  const { rows, total } = await listApiKeys(pagination);
  return paginatedJson({ data: rows, total, limit: pagination.limit, offset: pagination.offset });
}

export async function action({ request }: Route.ActionArgs): Promise<Response> {
  if (request.method !== 'POST') {
    throw jsonError(405, 'method not allowed');
  }

  await requireSuperadminApiKey(request);

  const { name, isSuperadmin } = await parseJsonBody(request, createApiKeyBodySchema);
  const { key, record } = await createApiKey({ name, isSuperadmin });

  return new Response(JSON.stringify({ key, record }), {
    status: 201,
    headers: { 'Content-Type': 'application/json' },
  });
}
