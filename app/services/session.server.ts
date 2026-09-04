/**
 * The browser session cookie: who is signed in, and since when.
 *
 * WHY A COOKIE AND NOT A BEARER TOKEN. The client here is a browser on the same
 * origin as the server, so there is no cross-origin request to make and nothing
 * to gain from a credential JavaScript can read. An httpOnly cookie cannot be
 * exfiltrated by injected script; a token in `localStorage` can. `sameSite:
 * 'lax'` plus React Router's own same-origin check is what replaces the CSRF
 * property a header-only credential would give, and `TRUST_PROXY` is set so the
 * framework sees the browser's origin through Traefik rather than the proxy's.
 *
 * WHAT IS STORED. The user id and the issue instant, and nothing else. No
 * password, no token, no email: the middleware re-reads the row on every
 * request, so a stale cookie cannot outlive the user it names.
 */
import { createCookieSessionStorage } from 'react-router';

import { CONFIG } from '#app/config';
import type { SessionData, SessionUser } from '#app/types/session';

/** Typed with `SessionData`, so `session.get('user')` returns a `SessionUser` rather than a value every caller asserts. */
export const sessionStorage = createCookieSessionStorage<SessionData>({
  cookie: {
    name: '_session',
    sameSite: 'lax',
    path: '/',
    httpOnly: true,
    secrets: [CONFIG.session.secret],
    secure: CONFIG.app.isProduction,
  },
});

export const { getSession, commitSession, destroySession } = sessionStorage;

/**
 * The `Set-Cookie` value that signs a user in.
 *
 * TAKES THE REQUEST RATHER THAN A `Session`, deliberately: a caller holding a
 * session it read earlier in the same handler would commit a snapshot and
 * silently drop whatever another line of that handler wrote.
 *
 * @param input.request the incoming request, read for its existing cookie.
 * @param input.userId the user this browser is now signed in as.
 * @param input.issuedAt when the session starts. Defaults to now.
 * @returns a `Set-Cookie` header value.
 */
export async function commitUserSession(input: {
  request: Request;
  userId: number;
  issuedAt?: Date;
}): Promise<string> {
  const session = await sessionStorage.getSession(input.request.headers.get('cookie'));
  session.set('user', { id: input.userId, issuedAt: (input.issuedAt ?? new Date()).toISOString() });
  return sessionStorage.commitSession(session);
}

/**
 * The `Set-Cookie` value that signs the caller out.
 *
 * DESTROYS THE WHOLE COOKIE rather than deleting the `user` key: a sign-out on
 * a shared device should leave nothing behind, and every other key this cookie
 * carries is a preference that costs nothing to rebuild.
 *
 * @param request the incoming request.
 * @returns a `Set-Cookie` header value that expires the cookie.
 */
export async function destroyUserSession(request: Request): Promise<string> {
  const session = await sessionStorage.getSession(request.headers.get('cookie'));
  return sessionStorage.destroySession(session);
}

/**
 * The `user` key, or `null` for anything unusable.
 *
 * IT NEVER THROWS. `getSession` REJECTS on a cookie it cannot unseal, and every
 * caller treats that as signed out: the usual causes are a rotated
 * `SESSION_SECRET` and a truncated cookie, and both should render a signed-out
 * page rather than a 500.
 *
 * @param request the incoming request, read only for its cookie header.
 * @returns the stored user, or `null`.
 */
export async function readUserSession(request: Request): Promise<SessionUser | null> {
  try {
    const session = await sessionStorage.getSession(request.headers.get('cookie'));
    return session.get('user') ?? null;
  } catch {
    return null;
  }
}
