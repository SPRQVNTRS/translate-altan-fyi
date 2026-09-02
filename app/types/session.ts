import type { OrgRole, OrgPermissionType } from './permissions';

/**
 * Cached organization membership stored in session
 */
export interface OrgMembership {
  orgId: string;
  orgSlug: string;
  orgName: string;
  role: OrgRole;
  permissions: OrgPermissionType[];
}

/**
 * Enhanced user type stored in session with multi-tenancy support
 */
export interface SessionUser {
  id: number;
  email: string;
  name: string;
  isSuperadmin: boolean;
  /** Cached organization memberships for quick access */
  memberships: OrgMembership[];
  /** Currently selected organization ID */
  currentOrgId: string | null;
  /** Currently selected organization slug */
  currentOrgSlug: string | null;
}

/**
 * Session data structure
 */
export interface SessionData {
  user: SessionUser;
}

/**
 * Tenant context available in org-scoped routes
 */
export interface TenantContextValue {
  userId: number;
  orgId: string;
  orgSlug: string;
  orgRole: OrgRole;
  permissions: OrgPermissionType[];
  isSuperadmin: boolean;
}
