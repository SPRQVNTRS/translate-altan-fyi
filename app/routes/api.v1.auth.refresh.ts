/**
 * `POST /api/v1/auth/refresh` — rotate the session pair (PROTOCOL.md §5.10).
 *
 * THE REFRESH TOKEN COMES FROM THE COOKIE, NEVER THE BODY. Upstream the client
 * holds the token and posts it; here it lives in the httpOnly session cookie,
 * so a body field would be a second, script-readable copy of the credential
 * this bridge exists to keep out of script's reach. A body is not read at all.
 *
 * THIS IS THE ONLY PLACE ROTATION HAPPENS, and that is a deliberate design
 * choice rather than a missing feature. `handleRefresh` treats an
 * already-revoked refresh token as the reuse signal and revokes the whole
 * family — correct against a stolen token, and catastrophic if triggered by
 * our own concurrency. React Router runs the loaders of every matched route in
 * parallel, so a transparent refresh inside `getAccountSession` would present
 * the same refresh token from N loaders at once and log the user out on every
 * navigation that straddles the 15-minute boundary. The full argument is on
 * `refreshAccountSession` in `app/services/account-session.server.ts`. A client
 * calls this route once, on a 401.
 *
 * `204`, NOT the rotated pair. The new tokens go into the cookie. Returning
 * them in the body would hand a fresh 30-day credential to any script that can
 * issue a `fetch`, which is exactly what the cookie transport is for.
 *
 * EVERY FAILURE IS `401` — an unknown token, an expired one, and a reused one
 * alike. `handleRefresh` decides which of those revokes a family; this route
 * only maps the outcome. On any failure the cookie is DESTROYED, so a browser
 * holding a dead pair lands on a signed-out page instead of retrying forever.
 */
import type { Route } from './+types/api.v1.auth.refresh';

import { handleRefresh } from '#app/lib/e2ee/auth-handlers';
import { createAuthContext } from '#app/lib/e2ee/e2ee-context.server';
import { sessionStorage } from '#app/services/session.server';
import { destroyAccountSession, refreshAccountSession } from '#app/services/account-session.server';
import { errorResponse, methodNotAllowed, outcomeResponse } from '#app/lib/e2ee-http.server';

const ALLOWED_METHODS = ['POST'] as const;

export function loader(): Response {
  return methodNotAllowed(ALLOWED_METHODS);
}

export async function action({ request }: Route.ActionArgs): Promise<Response> {
  if (request.method !== 'POST') return methodNotAllowed(ALLOWED_METHODS);

  const refreshToken = await refreshAccountSession(request);
  if (refreshToken === null) {
    return errorResponse(401, 'invalid refresh token', {
      'set-cookie': await destroyAccountSession(request),
    });
  }

  const outcome = await handleRefresh({ refreshToken }, createAuthContext());
  if (outcome.status !== 'ok') {
    return outcomeResponse(outcome, { 'set-cookie': await destroyAccountSession(request) });
  }

  // The account key is REWRITTEN rather than replaced: the id and handle in the
  // cookie are still correct and `handleRefresh` does not return them, so
  // reading the current key is the only way to carry them across a rotation.
  const session = await sessionStorage.getSession(request.headers.get('cookie'));
  const account = session.get('account');
  if (!account) {
    return errorResponse(401, 'invalid refresh token', {
      'set-cookie': await destroyAccountSession(request),
    });
  }

  session.set('account', {
    ...account,
    accessToken: outcome.body.tokens.accessToken,
    refreshToken: outcome.body.tokens.refreshToken,
  });

  return new Response(null, {
    status: 204,
    headers: { 'set-cookie': await sessionStorage.commitSession(session) },
  });
}
