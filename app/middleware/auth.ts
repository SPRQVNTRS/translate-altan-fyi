/**
 * The two gates in front of this application: the account gate and the
 * superadmin gate.
 *
 * THE USER IS RE-READ ON EVERY REQUEST, NEVER TRUSTED FROM THE COOKIE. The
 * cookie carries an id and an issue instant and nothing else, so `is_superadmin`
 * and the confirmed state are read from the row: a user deleted, demoted or
 * unconfirmed elsewhere stops working on the next request rather than when the
 * cookie expires.
 *
 * A PASSWORD CHANGE IS A SESSION EPOCH. `users.password_changed_at` is compared
 * against the cookie's `issuedAt`, and an older cookie is destroyed. That is how
 * a reset signs the other devices out with no session table to sweep. The tab
 * that made the change is handed a fresh cookie by
 * `app/services/auth.server.ts`, so it survives.
 *
 * A REFUSAL HAS TWO SHAPES, DECIDED BY THE PATH. A page route gets a redirect
 * to `/sign-in?next=`, which is what a browser navigation can act on; a route
 * under `/api/` gets a `401` in JSON, because a `fetch` cannot make sense of a
 * redirect to an HTML sign-in page.
 */
import type { MiddlewareFunction } from 'react-router';
import { redirect } from 'react-router';
import { eq } from 'drizzle-orm';

import { db } from '#drizzle/db';
import { users } from '#drizzle/schema';
import { SIGN_IN_PATH } from '#app/lib/auth/paths';
import { destroyUserSession, readUserSession } from '#app/services/session.server';
import { userContext, type AuthenticatedUser } from './context';

/** The one `401` body every API refusal shares. It never says whether the cookie was absent, expired or stale. */
const UNAUTHORIZED_BODY = { error: 'unauthorized: sign in to use this account' };

/**
 * The gate in front of the app surface.
 *
 * It sets `userContext` and stops there, so a gated screen costs one indexed
 * row read.
 */
export const authMiddleware: MiddlewareFunction = async ({ request, context }) => {
  const user = await resolveUser(request);
  if (user === null) throw await refuse(request);
  context.set(userContext, user);
};

/**
 * The gate in front of `/super/*`.
 *
 * IT ANSWERS 404, NOT 403, to a signed-in reader who is not a superadmin. A 403
 * confirms that the URL names something; a 404 says the tree has nothing there,
 * which is the truth as far as that reader is entitled to know it.
 *
 * IT RUNS AFTER `authMiddleware`, which is what puts the user in context. On
 * its own it refuses everybody.
 */
export const superadminMiddleware: MiddlewareFunction = ({ context }) => {
  const user = context.get(userContext);
  if (!user?.isSuperadmin) throw new Response('Not Found', { status: 404 });
};

/**
 * The signed-in user, or `null`.
 *
 * Four different "no" answers collapse into one `null`: no cookie, a cookie
 * that will not unseal, a user row that is gone or unconfirmed, and a session
 * older than the current password. It never throws and it never redirects.
 *
 * @param request the incoming request, read only for its cookie header.
 * @returns the user, or `null` when nobody is signed in.
 */
export async function resolveUser(request: Request): Promise<AuthenticatedUser | null> {
  const session = await readUserSession(request);
  if (session === null) return null;

  const user = await db.query.users.findFirst({ where: eq(users.id, session.id) });
  if (!user || user.emailVerifiedAt === null) return null;

  // The session epoch. A cookie minted before the current password was set
  // belongs to a device the owner has since locked out.
  if (new Date(session.issuedAt).getTime() < user.passwordChangedAt.getTime()) return null;

  return { id: user.id, email: user.email, isSuperadmin: user.isSuperadmin };
}

/** The two facts the client is given about the signed-in reader. Neither is a credential. */
export interface DisplayUser {
  /** Keys the device's own sync state and decides whether a cycle is worth starting. The cookie is what authorises one. */
  id: number;
  /** What the header renders. */
  email: string;
}

/**
 * The signed-in reader, for the chrome to render, or `null`.
 *
 * IT MUST NEVER GATE ANYTHING. It is the same read {@link resolveUser}
 * performs, exposed for the root loader, which has no middleware above it. A
 * screen that decides something from this value has turned a display read into
 * a credential.
 *
 * IT CARRIES THE ID AS WELL AS THE ADDRESS, and the id is not a leak: it is
 * what `app/lib/sync/sync-session.ts` keys this device's own bookkeeping on, so
 * without it the shell could not tell the sync engine that a session exists at
 * all. Every request the engine then makes is authorised by the httpOnly
 * cookie, never by this number.
 *
 * @param request the incoming request.
 * @returns the signed-in reader, or `null`.
 */
export async function readUserForDisplay(request: Request): Promise<DisplayUser | null> {
  const user = await resolveUser(request);
  return user === null ? null : { id: user.id, email: user.email };
}

/** The refusal this request should get: JSON for `/api/`, a redirect for everything else. */
async function refuse(request: Request): Promise<Response> {
  const setCookie = await destroyUserSession(request);
  const url = new URL(request.url);

  if (url.pathname.startsWith('/api/')) {
    return Response.json(UNAUTHORIZED_BODY, { status: 401, headers: { 'Set-Cookie': setCookie } });
  }

  // `next` carries the path and query only. An absolute URL here would let a
  // crafted link bounce a reader off this app onto somebody else's after they
  // signed in.
  const next = `${url.pathname}${url.search}`;
  const target = next === '/' ? SIGN_IN_PATH : `${SIGN_IN_PATH}?next=${encodeURIComponent(next)}`;
  return redirect(target, { headers: { 'Set-Cookie': setCookie } });
}
