import { userContext, type AuthenticatedUser } from './context';

// Re-export for convenience
export type { AuthenticatedUser };

/**
 * The authenticated user.
 *
 * @param context the route context.
 * @returns the user `authMiddleware` resolved from the session cookie.
 * @throws when the route is not behind `authMiddleware`, a wiring bug rather than a
 *   signed-out visitor, which the middleware already redirected.
 */
export function getUser(context: {
  get: (ctx: typeof userContext) => AuthenticatedUser | null;
}): AuthenticatedUser {
  const user = context.get(userContext);
  if (!user) {
    throw new Error('User not found in context. This route may not be protected by authMiddleware.');
  }
  return user;
}

/**
 * The authenticated user, or `null`.
 *
 * For a route that renders in both states and is NOT behind `authMiddleware`.
 * It never throws, because signed out is a normal answer there.
 *
 * @param context the route context.
 * @returns the user, or `null`.
 */
export function maybeGetUser(context: {
  get: (ctx: typeof userContext) => AuthenticatedUser | null;
}): AuthenticatedUser | null {
  return context.get(userContext);
}
