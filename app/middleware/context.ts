import type { SelectUser, SelectOrganization as Organization } from '#drizzle/schema';
import type { TenantContextValue, OrgMembership } from '#app/types/session';
import { createContext } from 'react-router';

/**
 * Extended user type that includes session membership data
 * Defined here to avoid circular dependency with helpers.ts
 */
export type AuthenticatedUser = SelectUser & {
  memberships: OrgMembership[];
  currentOrgId: string | null;
  currentOrgSlug: string | null;
};

/** User context - set by authMiddleware (includes membership data from session) */
export const userContext = createContext<AuthenticatedUser | null>(null);

/** Tenant context - set by tenantMiddleware for org-scoped routes */
export const tenantContext = createContext<TenantContextValue | null>(null);

/** Organization context - set by tenantMiddleware */
export const orgContext = createContext<Organization | null>(null);
