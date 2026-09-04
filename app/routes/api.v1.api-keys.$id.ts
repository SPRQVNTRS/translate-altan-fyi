/**
 * DELETE /api/v1/api-keys/:id — Revoke an API key (superadmin only)
 *
 * The calling key must carry `is_superadmin`. A key can revoke itself, which is
 * deliberate: it is the one revocation an operator can perform holding nothing
 * but the key they want to burn.
 */

import type { Route } from './+types/api.v1.api-keys.$id';
import { requireSuperadminApiKey, jsonError } from '#app/lib/api-auth.server';
import { revokeApiKey } from '#app/models/api-keys.server';

export async function action({ request, params }: Route.ActionArgs): Promise<Response> {
  if (request.method !== 'DELETE') {
    throw jsonError(405, 'method not allowed');
  }

  await requireSuperadminApiKey(request);

  const { id } = params;
  if (!id) {
    throw jsonError(400, 'missing id param');
  }

  const record = await revokeApiKey(id);
  if (!record) {
    throw jsonError(404, `api key not found: ${id}`);
  }

  return new Response(JSON.stringify({ record }), {
    headers: { 'Content-Type': 'application/json' },
  });
}
