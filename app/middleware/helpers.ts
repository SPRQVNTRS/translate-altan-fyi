import { userContext, type AuthenticatedUser } from './context';

// Re-export for convenience
export type { AuthenticatedUser };

/**
 * Get authenticated user from context
 * @param context - Route context object
 * @returns User object with membership data
 * @throws Error if user is not found in context
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
