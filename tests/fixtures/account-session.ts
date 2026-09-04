/**
 * A real, invited, signed-in account, and the cookie a request carries to be
 * that account.
 *
 * WHY THE INTEGRATION TIER NEEDS THIS AT ALL, AND WHY IT IS NOT A STUB
 *   M184 gates the app on an account session. Every case that asks "and does a
 *   signed-in caller still get through" therefore needs a session that the
 *   production code path actually accepts, which means a real `accounts` row, a
 *   real `account_tokens` digest and a real signed cookie. A hand-built cookie
 *   carrying an invented token resolves to `null` in `getAccountSession` and
 *   would make every such case pass for the wrong reason: it would prove the
 *   gate refuses everybody, which is not the claim.
 *
 *   That matters most in the wallet test. A zero enqueue count for a signed-out
 *   request means nothing unless the SAME request signed in produces a non-zero
 *   one, and only a session the app really accepts can show that.
 *
 * IT GOES THROUGH THE INVITE, LIKE EVERY OTHER SIGNUP
 *   The account is created by `handleSignup` against the app's OWN
 *   `createAuthContext`, spending an invite row minted with the app's own
 *   pepper. Inserting an `accounts` row directly would be faster and would test
 *   a door this app no longer has.
 *
 * WHAT IT NEVER DOES
 *   It never prints a token, an invite or a verifier: a failing test's output
 *   ends up in a terminal and a scrollback, and both of those are bearer
 *   credentials. It never deletes a row it did not create. Handles carry a
 *   run-scoped random suffix so two runs cannot collide, and `dispose()` takes
 *   the account and the invite away by id.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { inArray } from 'drizzle-orm';

import { db } from '../../drizzle/db';
import { accounts, invites } from '../../drizzle/schema';
import { CONFIG } from '../../app/config';
import { handleSignup } from '../../app/lib/e2ee/auth-handlers';
import { createAuthContext } from '../../app/lib/e2ee/e2ee-context.server';
import { DEFAULT_ARGON2_PARAMS } from '../../app/lib/e2ee/kdf-descriptor';
import { computeInviteTokenHash, deriveInviteTokenPepper, generateInviteToken } from '../../app/lib/invites/token';
import { commitAccountSession } from '../../app/services/account-session.server';

/** A signed-in account, and everything needed to act as it and then remove it. */
export interface TestAccountSession {
  accountId: number;
  handle: string;
  /**
   * The value for a request's `cookie` header. The name/value pair only: a
   * `Set-Cookie` string carries `Path`, `HttpOnly` and friends, which a REQUEST
   * header must not.
   */
  cookie: string;
  /** Deletes the account and the invite this fixture created, and nothing else. */
  dispose: () => Promise<void>;
}

/** The invite pepper this installation is actually using, so a minted row is one signup will accept. */
const invitePepper = deriveInviteTokenPepper(CONFIG.e2ee.serverSecret);

/**
 * Mints one invite, signs one account up with it, and signs that account in.
 *
 * @param label a short word naming the caller, so a stray row is traceable to
 *   the test that made it.
 * @returns the account, its request cookie, and its own cleanup.
 */
export async function createTestAccountSession(label: string): Promise<TestAccountSession> {
  const token = generateInviteToken();
  const [invite] = await db
    .insert(invites)
    .values({ tokenHash: computeInviteTokenHash({ token, pepper: invitePepper }) })
    .returning({ id: invites.id });
  if (!invite) throw new Error('could not mint the test invite');

  const handle = `zztest-${label}-${randomUUID().slice(0, 8)}`;
  const outcome = await handleSignup(
    {
      handle,
      // A well-formed authenticator that no browser derived. Nothing in these
      // cases signs in with a passphrase, so the hash only has to be the right
      // shape for the store to hold.
      authHash: randomBytes(32).toString('base64'),
      kdfDescriptor: {
        salt: randomBytes(16).toString('base64'),
        params: {
          memorySizeKib: DEFAULT_ARGON2_PARAMS.memorySizeKib,
          iterations: DEFAULT_ARGON2_PARAMS.iterations,
          parallelism: DEFAULT_ARGON2_PARAMS.parallelism,
        },
      },
      inviteToken: token,
    },
    createAuthContext(),
  );

  if (outcome.status !== 'created') {
    // The invite was minted a line ago with this installation's own pepper, so
    // a refusal here is a wiring problem and not a test failure to interpret.
    // The reason is a fixed string on this path and carries no token.
    throw new Error(`the fixture's own signup was refused: ${outcome.status}`);
  }

  const setCookie = await commitAccountSession({
    request: new Request('https://translate.altan.fyi/'),
    tokens: outcome.body.tokens,
    account: outcome.body.account,
  });

  const accountId = outcome.body.account.id;
  return {
    accountId,
    handle,
    cookie: setCookie.split(';')[0] ?? '',
    dispose: async () => {
      await db.delete(accounts).where(inArray(accounts.id, [accountId]));
      // Separately, and by id. `invites.redeemed_by_account_id` is
      // `ON DELETE SET NULL` on purpose, so the row does not cascade.
      await db.delete(invites).where(inArray(invites.id, [invite.id]));
    },
  };
}
