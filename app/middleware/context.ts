import type { SelectAccount, SelectUser, SelectOrganization as Organization } from '#drizzle/schema';
import type { TenantContextValue, OrgMembership } from '#app/types/session';
import { createContext } from 'react-router';

/**
 * The authenticated ACCOUNT — who the caller is.
 *
 * Trimmed to what an authorization decision needs. Notably `isSuperadmin`,
 * which moved here from `users`: authentication lives on `accounts`, so the
 * flag that decides who may reach an admin surface has to move with it.
 * Leaving it on `users` would mean an account authenticates and is then
 * authorised against a row it has no relation to.
 */
export type AuthenticatedAccount = Pick<SelectAccount, 'id' | 'handle' | 'displayName' | 'isSuperadmin'>;

/**
 * The linked `users` row — what the caller may do in an ORGANIZATION.
 *
 * `users` and the org tables survive for the org and api-key surface only.
 * They are reached through `users.accountId`, so an account with no linked row
 * simply has no org surface; that is not an error, and `authMiddleware` sends
 * such a caller to the app rather than to a crash.
 */
export type AuthenticatedUser = SelectUser & {
  memberships: OrgMembership[];
  currentOrgId: string | null;
  currentOrgSlug: string | null;
};

/** Account context — set by `authMiddleware` from the session cookie. */
export const accountContext = createContext<AuthenticatedAccount | null>(null);

/** User context — set by `authMiddleware` when the account has a linked `users` row. */
export const userContext = createContext<AuthenticatedUser | null>(null);

/** Tenant context - set by tenantMiddleware for org-scoped routes */
export const tenantContext = createContext<TenantContextValue | null>(null);

/** Organization context - set by tenantMiddleware */
export const orgContext = createContext<Organization | null>(null);
