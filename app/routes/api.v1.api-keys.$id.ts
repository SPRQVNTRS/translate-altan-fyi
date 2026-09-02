/**
 * DELETE /api/v1/api-keys/:id — Revoke an API key (superadmin only)
 *
 * Cross-tenant revoke: the caller does not need to belong to the key's org.
 * Requires the Bearer token's creator to have isSuperadmin=true on users table.
 */

import type { Route } from './+types/api.v1.api-keys.$id';
import { requireSuperadminApiKey, jsonError } from '#app/lib/api-auth.server';
import { adminRevokeApiKey } from '#app/models/api-keys.server';

export async function action({ request, params }: Route.ActionArgs): Promise<Response> {
  if (request.method !== 'DELETE') {
    throw jsonError(405, 'method not allowed');
  }

  await requireSuperadminApiKey(request);

  const { id } = params;
  if (!id) {
    throw jsonError(400, 'missing id param');
  }

  const record = await adminRevokeApiKey(id);
  if (!record) {
    throw jsonError(404, `api key not found: ${id}`);
  }

  return new Response(JSON.stringify({ record }), {
    headers: { 'Content-Type': 'application/json' },
  });
}
