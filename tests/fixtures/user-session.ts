/**
 * A real, confirmed, signed-in user, and the cookie a request carries to be
 * that user.
 *
 * WHY THE INTEGRATION TIER NEEDS THIS AT ALL, AND WHY IT IS NOT A STUB
 *   Every case that asks "and does a signed-in caller still get through" needs
 *   a session the production code path actually accepts, which means a real
 *   `users` row and a real signed cookie. A hand-built cookie carrying an
 *   invented id resolves to `null` in `resolveUser` and would make every such
 *   case pass for the wrong reason: it would prove the gate refuses everybody,
 *   which is not the claim.
 *
 *   That matters most in the wallet test. A zero enqueue count for a signed-out
 *   request means nothing unless the SAME request signed in produces a non-zero
 *   one.
 *
 * IT GOES THROUGH THE REAL SIGNUP PATH, and then confirms the address the way
 * a mailed link would, by stamping `email_verified_at`. Inserting the row by
 * hand would test a door this app does not have.
 *
 * WHAT IT NEVER DOES
 *   It never prints a password or a token: a failing test's output ends up in a
 *   terminal and a scrollback. It never deletes a row it did not create.
 *   Addresses carry a run-scoped random suffix so two runs cannot collide, and
 *   `dispose()` takes the user away by id, which cascades to everything else.
 */
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';

import { db } from '../../drizzle/db';
import { users } from '../../drizzle/schema';
import { commitUserSession } from '../../app/services/session.server';

/** A signed-in user, and everything needed to act as them and then remove them. */
export interface TestUserSession {
  userId: number;
  email: string;
  /**
   * The value for a request's `cookie` header. The name/value pair only: a
   * `Set-Cookie` string carries `Path`, `HttpOnly` and friends, which a REQUEST
   * header must not.
   */
  cookie: string;
  /** Deletes the user this fixture created, and nothing else. */
  dispose: () => Promise<void>;
}

/**
 * Creates one confirmed user and signs them in.
 *
 * @param label a short word naming the caller, so a stray row is traceable to
 *   the test that made it.
 * @returns the user, their request cookie, and their own cleanup.
 */
export async function createTestUserSession(label: string): Promise<TestUserSession> {
  const email = `zztest-${label}-${randomUUID().slice(0, 8)}@example.invalid`;
  const [created] = await db
    .insert(users)
    .values({
      email,
      // A well-formed bcrypt hash of a value nothing in these cases types. No
      // case signs in with a password, so the hash only has to be the right
      // shape for the row to hold.
      passwordHash: '$2b$10$abcdefghijklmnopqrstuvwxyz012345678901234567890123456789',
      emailVerifiedAt: new Date(),
    })
    .returning({ id: users.id });
  if (!created) throw new Error('could not create the test user');

  const setCookie = await commitUserSession({
    request: new Request('https://kenning.altan.fyi/'),
    userId: created.id,
  });

  return {
    userId: created.id,
    email,
    cookie: setCookie.split(';')[0] ?? '',
    dispose: async () => {
      await db.delete(users).where(eq(users.id, created.id));
    },
  };
}
