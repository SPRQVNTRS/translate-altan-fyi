/**
 * `POST /api/v1/auth/logout` — revoke this device's token family
 * (PROTOCOL.md §5.11). `204`.
 *
 * ONE DEVICE, NOT THE ACCOUNT. `handleLogout` revokes the caller's family,
 * which is the pair this browser holds. The account's other sessions are
 * untouched — that is what §4.2 reserves for a passphrase change and a
 * recovery rotation.
 *
 * THE COOKIE IS DESTROYED ON EVERY PATH, INCLUDING FAILURE. A caller whose
 * token no longer resolves is already signed out as far as the server is
 * concerned, and leaving a dead credential in their browser would only make
 * the next request fail more confusingly. So a logout can be refused by the
 * store but never by this route: there is no state in which "you are still
 * signed in" is the useful answer to someone asking to leave.
 */
import type { Route } from './+types/api.v1.auth.logout';

import { handleLogout, resolveAccessToken } from '#app/lib/e2ee/auth-handlers';
import { createAuthContext } from '#app/lib/e2ee/e2ee-context.server';
import { sessionStorage } from '#app/services/session.server';
import { destroyAccountSession } from '#app/services/account-session.server';
import { methodNotAllowed } from '#app/lib/e2ee-http.server';

const ALLOWED_METHODS = ['POST'] as const;

export function loader(): Response {
  return methodNotAllowed(ALLOWED_METHODS);
}

export async function action({ request }: Route.ActionArgs): Promise<Response> {
  if (request.method !== 'POST') return methodNotAllowed(ALLOWED_METHODS);

  const setCookie = await destroyAccountSession(request);
  const accessToken = await readAccessToken(request);

  if (accessToken !== null) {
    const ctx = createAuthContext();
    const resolved = await resolveAccessToken(accessToken, ctx);
    if (resolved !== null) await handleLogout(resolved, ctx);
  }

  return new Response(null, { status: 204, headers: { 'set-cookie': setCookie } });
}

/** The access token in the cookie, or `null`. An unsealable cookie is a signed-out visitor, never a 500. */
async function readAccessToken(request: Request): Promise<string | null> {
  try {
    const session = await sessionStorage.getSession(request.headers.get('cookie'));
    return session.get('account')?.accessToken ?? null;
  } catch {
    return null;
  }
}
