/**
 * GET /api/v1/users/by-email/:email → { user: SafeUser }
 *
 * Auth: superadmin API key only.
 */

import type { Route } from './+types/api.v1.users.by-email.$email';
import { requireSuperadminApiKey, jsonError } from '#app/lib/api-auth.server';
import { getUserByEmailAdmin } from '#app/models/users-admin.server';

export async function loader({ request, params }: Route.LoaderArgs): Promise<Response> {
  await requireSuperadminApiKey(request);

  const email = params.email ? decodeURIComponent(params.email) : '';
  if (!email) throw jsonError(400, 'missing email parameter');

  const user = await getUserByEmailAdmin(email);
  if (!user) throw jsonError(404, 'user not found');

  return new Response(JSON.stringify({ user }), {
    headers: { 'Content-Type': 'application/json' },
  });
}

export async function action(): Promise<Response> {
  throw jsonError(405, 'method not allowed');
}
