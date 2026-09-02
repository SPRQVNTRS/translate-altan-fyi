/**
 * GET  /api/v1/users/:id         → { user: SafeUser }
 * PATCH /api/v1/users/:id        body: { deactivated?: boolean, isSuperadmin?: boolean } → { user: SafeUser }
 *
 * Auth: superadmin API key only.
 */

import { z } from 'zod';
import type { Route } from './+types/api.v1.users.$id';
import { requireSuperadminApiKey, jsonError, parseJsonBody } from '#app/lib/api-auth.server';
import { getUserByIdAdmin, patchUserAdmin } from '#app/models/users-admin.server';

/** Body accepted by `PATCH /api/v1/users/:id`. At least one field is required. */
const patchUserBodySchema = z
  .object({
    deactivated: z.boolean().optional(),
    isSuperadmin: z.boolean().optional(),
  })
  .refine(
    (fields) => fields.deactivated !== undefined || fields.isSuperadmin !== undefined,
    { message: 'body must include at least one of: deactivated, isSuperadmin' },
  );

export async function loader({ request, params }: Route.LoaderArgs): Promise<Response> {
  await requireSuperadminApiKey(request);

  const id = parseInt(params.id ?? '', 10);
  if (isNaN(id)) throw jsonError(400, 'user id must be a number');

  const user = await getUserByIdAdmin(id);
  if (!user) throw jsonError(404, 'user not found');

  return new Response(JSON.stringify({ user }), {
    headers: { 'Content-Type': 'application/json' },
  });
}

export async function action({ request, params }: Route.ActionArgs): Promise<Response> {
  if (request.method !== 'PATCH') throw jsonError(405, 'method not allowed');

  await requireSuperadminApiKey(request);

  const id = parseInt(params.id ?? '', 10);
  if (isNaN(id)) throw jsonError(400, 'user id must be a number');

  const fields = await parseJsonBody(request, patchUserBodySchema);

  const user = await patchUserAdmin(id, fields);
  if (!user) throw jsonError(404, 'user not found');

  return new Response(JSON.stringify({ user }), {
    headers: { 'Content-Type': 'application/json' },
  });
}
