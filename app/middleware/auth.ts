/**
 * The gate in front of the org and admin surface.
 *
 * IT RESOLVES AN ACCOUNT, NOT A `users` ROW. Authentication moved to
 * `accounts` when the bcrypt path was deleted: there is no `users.password`
 * column any more, `/login` is not the sign-in page any more, and a session
 * key called `user` is not written by anything. This middleware therefore
 * reads the ACCOUNT session (`app/services/account-session.server.ts`), which
 * resolves an opaque access token out of the httpOnly cookie, and only then
 * looks for the `users` row that account is linked to.
 *
 * THE ORG SURFACE STILL RUNS ON `users`, and that is deliberate rather than
 * transitional. Memberships, roles, permissions and API keys are all keyed on
 * `users.id`, and none of that moved. `users.accountId` is the join, so an
 * account either has an org profile or does not.
 *
 * AN ACCOUNT WITH NO LINKED `users` ROW IS SENT TO THE APP, NOT TO AN ERROR.
 * Almost every account on this service is a person syncing their own
 * vocabulary lists and has no business inside an organization; `users` rows
 * are provisioned out of band. Redirecting is the honest answer, and throwing
 * would turn "you have no org profile" into a 500.
 *
 * MEMBERSHIPS ARE READ FROM THE DATABASE, NOT FROM THE COOKIE. They used to be
 * cached in the session by the bcrypt login. Nothing writes that cache now, and
 * a stale copy of somebody's permissions is the wrong thing to keep in a cookie
 * anyway: a revoked membership must stop working on the next request, not on
 * the next sign-in.
 */
import type { MiddlewareFunction } from 'react-router';
import { redirect } from 'react-router';
import { eq } from 'drizzle-orm';

import { db } from '#drizzle/db';
import { accounts, users } from '#drizzle/schema';
import {
  ACCOUNT_LOGIN_PATH,
  destroyAccountSession,
  getAccountSession,
} from '#app/services/account-session.server';
import { getUserMembershipsForSession } from '#app/models/organizations.server';
import { accountContext, userContext } from './context';

/** Where an account without an org profile lands. The app shell, which needs no `users` row. */
const NO_ORG_PROFILE_PATH = '/';

export const authMiddleware: MiddlewareFunction = async ({ request, context }) => {
  const session = await getAccountSession(request);
  if (!session) {
    throw redirect(ACCOUNT_LOGIN_PATH);
  }

  // Re-read rather than trust the cookie: `isSuperadmin` is an authorization
  // input, and a flag revoked in the database must stop working on the next
  // request rather than when the cookie expires.
  const account = await db.query.accounts.findFirst({ where: eq(accounts.id, session.accountId) });
  if (!account) {
    // The token outlived the account — deleted from another device. Clear the
    // cookie so the next request is a clean signed-out one.
    throw redirect(ACCOUNT_LOGIN_PATH, {
      headers: { 'Set-Cookie': await destroyAccountSession(request) },
    });
  }

  context.set(accountContext, {
    id: account.id,
    handle: account.handle,
    displayName: account.displayName,
    isSuperadmin: account.isSuperadmin,
  });

  const dbUser = await db.query.users.findFirst({ where: eq(users.accountId, account.id) });
  if (!dbUser || dbUser.deactivated) {
    throw redirect(NO_ORG_PROFILE_PATH);
  }

  const memberships = await getUserMembershipsForSession(dbUser.id);
  context.set(userContext, {
    ...dbUser,
    memberships,
    currentOrgId: memberships[0]?.orgId ?? null,
    currentOrgSlug: memberships[0]?.orgSlug ?? null,
  });
};

/**
 * Superadmin gate.
 *
 * READS `accounts.is_superadmin`, NOT `users.is_superadmin`. The flag followed
 * authentication onto `accounts`; checking the `users` copy would authorise a
 * caller against a row they did not authenticate as. Granted out of band by
 * `pnpm cli account grant-superadmin <handle>`, never through the API.
 */
export const superadminMiddleware: MiddlewareFunction = async ({ context }) => {
  const account = context.get(accountContext);

  if (!account?.isSuperadmin) {
    throw redirect('/select-org');
  }
};

/**
 * The gate in front of the APP surface, added by M184.
 *
 * WHY IT IS NOT `authMiddleware`, WHICH ALREADY EXISTS.
 *   `authMiddleware` above requires TWO things: an account session AND a
 *   linked `users` row, and it redirects to `/` when the second one is
 *   missing. That is right for the org and admin surface it guards, and it is
 *   wrong here. Almost every account on this service is a person syncing their
 *   own vocabulary lists, and `users` rows are provisioned out of band, so
 *   reusing it would bounce nearly every INVITED, SIGNED-IN reader off
 *   `/entry/:headwordId` and back to the home screen. The gate this milestone
 *   needs asks one question, "is there an account behind this request", and
 *   the org profile is none of its business.
 *
 * IT SETS `accountContext` AND STOPS THERE. No `users` lookup, no membership
 * read, so a gated app screen costs one indexed token lookup and one accounts
 * row rather than four queries it renders nothing from.
 *
 * WHERE IT IS MOUNTED, AND WHY NOT ON `_app` ITSELF. See the header of
 * `app/routes/_app.gated.tsx`: `/` must stay a public 200 for a signed-out
 * visitor, and `/` sits inside `_app`, so the middleware hangs off a child
 * layout that holds only the routes with no public surface at all.
 */
export const accountMiddleware: MiddlewareFunction = async ({ request, context }) => {
  const session = await getAccountSession(request);
  if (!session) {
    throw redirect(ACCOUNT_LOGIN_PATH);
  }

  // Re-read rather than trust the cookie, for the reason `authMiddleware`
  // states: a deleted account must stop working on the next request, not when
  // the cookie expires.
  const account = await db.query.accounts.findFirst({ where: eq(accounts.id, session.accountId) });
  if (!account) {
    throw redirect(ACCOUNT_LOGIN_PATH, {
      headers: { 'Set-Cookie': await destroyAccountSession(request) },
    });
  }

  context.set(accountContext, {
    id: account.id,
    handle: account.handle,
    displayName: account.displayName,
    isSuperadmin: account.isSuperadmin,
  });
};
