/**
 * `GET /api/v1/auth/devices` — the account's live sessions.
 * `DELETE /api/v1/auth/devices` — end one of them.
 *
 * A DEVICE IS A TOKEN FAMILY. There is no device registry behind this route
 * and there must not be one; `app/services/account-devices.server.ts` carries
 * the reasoning, which is PROTOCOL.md section 4.2's: a `family_id` survives
 * rotation, `logout` revokes one family, and reuse detection revokes a family.
 *
 * Both verbs require a signed-in session. An absent or dead one is a `401`,
 * never a redirect: this is a JSON surface and a 302 to an HTML page is the
 * wrong shape for the fetch that called it. The account comes from the SESSION
 * and never from the request, so a caller does not get to name whose devices it
 * is reading or ending.
 *
 * NO TOKEN AND NO DIGEST CROSSES THIS BOUNDARY. The response carries family
 * ids, two timestamps and a boolean. A family id is a handle for a revoke, not
 * a credential: presenting one proves nothing and revoking one requires the
 * session cookie anyway.
 *
 * Timestamps are ISO-8601 UTC strings (PROTOCOL.md section 4).
 */
import { z } from 'zod';

import type { Route } from './+types/api.v1.auth.devices';

import { getAccountSession } from '#app/services/account-session.server';
import { listAccountDevicesForRequest, revokeAccountDevice } from '#app/services/account-devices.server';
import { errorResponse, jsonResponse, methodNotAllowed, readJsonBody } from '#app/lib/e2ee-http.server';

const ALLOWED_METHODS = ['GET', 'DELETE'] as const;

/** The one `401` both verbs share. Never says whether the cookie was absent, expired or revoked. */
const NOT_SIGNED_IN = 'unauthorized: sign in to use this account';

/** The `DELETE` body. A family id is an opaque handle, so its only rule is that it is a non-empty string. */
const revokeRequestSchema = z.object({ familyId: z.string().min(1) });

export async function loader({ request }: Route.LoaderArgs): Promise<Response> {
  if (request.method !== 'GET') return methodNotAllowed(ALLOWED_METHODS);

  const session = await getAccountSession(request);
  if (session === null) return errorResponse(401, NOT_SIGNED_IN);

  const devices = await listAccountDevicesForRequest({ request, accountId: session.accountId });
  return jsonResponse({ devices }, 200);
}

/**
 * `DELETE` alone. `POST` and `PUT` get a `405` with an `Allow` header.
 *
 * REVOKING THE CURRENT DEVICE IS ALLOWED. It is a sign-out, and refusing the
 * one row in the list the user most obviously owns would be a surprise with
 * nothing behind it.
 *
 * IT DOES NOT CLEAR THE SESSION COOKIE. Ending a family server-side and
 * expiring a browser cookie are two different operations, and this route does
 * only the first, so its behaviour does not change depending on which device
 * was named. A client that has just revoked its own family must navigate to
 * `/logout`, which is the route that destroys the cookie;
 * `app/components/account/device-list.tsx` does exactly that.
 */
export async function action({ request }: Route.ActionArgs): Promise<Response> {
  if (request.method !== 'DELETE') return methodNotAllowed(ALLOWED_METHODS);

  const session = await getAccountSession(request);
  if (session === null) return errorResponse(401, NOT_SIGNED_IN);

  const parsed = revokeRequestSchema.safeParse(await readJsonBody(request));
  if (!parsed.success) return errorResponse(400, 'invalid request: familyId must be a non-empty string');

  // AN UNKNOWN OR FOREIGN FAMILY IS ALSO A 200. A `404` here would confirm
  // which family ids exist on this server, which is exactly the probe the
  // account filter inside `revokeAccountDevice` exists to defeat. The caller
  // gets the same outcome either way, which is that the named session is not
  // usable, so there is nothing for a distinct status to tell an honest client.
  await revokeAccountDevice({ accountId: session.accountId, familyId: parsed.data.familyId });
  return jsonResponse({ ok: true }, 200);
}
