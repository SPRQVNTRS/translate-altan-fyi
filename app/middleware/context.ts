import type { SelectUser } from '#drizzle/schema';
import { createContext } from 'react-router';

/**
 * The authenticated USER: who the caller is, and the only identity this
 * application has.
 *
 * Trimmed to what a screen or an authorization decision needs. Notably
 * `isSuperadmin`, which lives on `users` because authentication does: a flag on
 * any other row would authorise a caller against something they did not
 * authenticate as.
 */
export type AuthenticatedUser = Pick<SelectUser, 'id' | 'email' | 'isSuperadmin'>;

/** User context, set by `authMiddleware` from the session cookie. */
export const userContext = createContext<AuthenticatedUser | null>(null);
