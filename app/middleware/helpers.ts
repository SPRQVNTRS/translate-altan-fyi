import { accountContext, userContext, type AuthenticatedAccount, type AuthenticatedUser } from './context';

// Re-export for convenience
export type { AuthenticatedAccount, AuthenticatedUser };

/**
 * The authenticated account.
 *
 * @param context the route context.
 * @returns the account `authMiddleware` resolved from the session cookie.
 * @throws when the route is not behind `authMiddleware` — a wiring bug, not a
 *   signed-out visitor, which the middleware already redirected.
 */
export function getAccount(
  context: { get: (ctx: typeof accountContext) => AuthenticatedAccount | null },
): AuthenticatedAccount {
  const account = context.get(accountContext);
  if (!account) {
    throw new Error('Account not found in context. This route may not be protected by authMiddleware.');
  }
  return account;
}

/**
 * The `users` row linked to the authenticated account, for the ORG surface.
 *
 * Separate from {@link getAccount} because the two answer different questions:
 * the account is who the caller is, the user row is what they may do inside an
 * organization. `authMiddleware` guarantees both are set on the routes that
 * reach this, so a throw here is a wiring bug rather than a missing profile —
 * an account with no linked row never gets past the middleware.
 *
 * @param context the route context.
 * @returns the user row with its cached memberships.
 * @throws when the route is not behind `authMiddleware`.
 */
export function getUser(
  context: { get: (ctx: typeof userContext) => AuthenticatedUser | null },
): AuthenticatedUser {
  const user = context.get(userContext);
  if (!user) {
    throw new Error('User not found in context. This route may not be protected by authMiddleware.');
  }
  return user;
}
