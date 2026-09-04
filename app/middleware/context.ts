import type { SelectAccount } from '#drizzle/schema';
import { createContext } from 'react-router';

/**
 * The authenticated ACCOUNT — who the caller is, and the only identity this
 * application has.
 *
 * Trimmed to what an authorization decision needs. Notably `isSuperadmin`,
 * which lives on `accounts` because authentication does: a flag on any other
 * row would authorise a caller against something they did not authenticate as.
 */
export type AuthenticatedAccount = Pick<SelectAccount, 'id' | 'handle' | 'displayName' | 'isSuperadmin'>;

/** Account context — set by `accountMiddleware` from the session cookie. */
export const accountContext = createContext<AuthenticatedAccount | null>(null);
