/**
 * The two gates in front of this application: the account gate and the
 * superadmin gate.
 *
 * BOTH RESOLVE AN ACCOUNT, AND NOTHING ELSE. There was a third one,
 * `authMiddleware`, which resolved an account and then demanded the `users` row
 * it was linked to before letting anybody through. It went with the `users`
 * table in M189 (ADR-0010): the org surface it guarded held zero rows, and the
 * extra demand meant a signed-in reader with no org profile, which is every
 * reader, was bounced back to the home screen.
 *
 * THE ACCOUNT IS RE-READ ON EVERY REQUEST, NEVER TRUSTED FROM THE COOKIE.
 * `is_superadmin` is an authorization input, and an account deleted or demoted
 * elsewhere must stop working on the next request rather than when the cookie
 * expires.
 */
import type { MiddlewareFunction } from 'react-router';
import { redirect } from 'react-router';
import { eq } from 'drizzle-orm';

import { db } from '#drizzle/db';
import { accounts } from '#drizzle/schema';
import {
  ACCOUNT_LOGIN_PATH,
  destroyAccountSession,
  getAccountSession,
} from '#app/services/account-session.server';
import { accountContext } from './context';

/**
 * Superadmin gate.
 *
 * READS `accounts.is_superadmin`. Granted out of band by
 * `pnpm cli account grant-superadmin <handle>`, never through the API. It is
 * the SCREEN-level flag; the bearer-token surface has its own, on the key
 * itself (`api_keys.is_superadmin`), and neither reads the other.
 *
 * IT RUNS AFTER `accountMiddleware`, which is what puts the account in context.
 * A caller who is signed in but not a superadmin lands on `/account`, the one
 * screen that can tell them who they are signed in as. It used to be
 * `/select-org`, which no longer exists.
 */
export const superadminMiddleware: MiddlewareFunction = async ({ context }) => {
  const account = context.get(accountContext);

  if (!account?.isSuperadmin) {
    throw redirect('/account');
  }
};

/**
 * The gate in front of the APP surface, added by M184.
 *
 * IT ASKS ONE QUESTION: is there an account behind this request. It sets
 * `accountContext` and stops there, so a gated app screen costs one indexed
 * token lookup and one accounts row.
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

  // Re-read rather than trust the cookie, for the reason the file header
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
