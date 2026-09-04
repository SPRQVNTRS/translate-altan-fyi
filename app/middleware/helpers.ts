import { accountContext, type AuthenticatedAccount } from './context';

// Re-export for convenience
export type { AuthenticatedAccount };

/**
 * The authenticated account.
 *
 * @param context the route context.
 * @returns the account `accountMiddleware` resolved from the session cookie.
 * @throws when the route is not behind `accountMiddleware` — a wiring bug, not
 *   a signed-out visitor, which the middleware already redirected.
 */
export function getAccount(
  context: { get: (ctx: typeof accountContext) => AuthenticatedAccount | null },
): AuthenticatedAccount {
  const account = context.get(accountContext);
  if (!account) {
    throw new Error('Account not found in context. This route may not be protected by accountMiddleware.');
  }
  return account;
}
