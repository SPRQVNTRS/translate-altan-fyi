import { z } from 'zod';

/**
 * Organization-level permissions for multi-tenancy
 */

export const OrgPermission = {
  // Content permissions
  ARTICLES_READ: 'articles:read',
  ARTICLES_WRITE: 'articles:write',
  ARTICLES_DELETE: 'articles:delete',

  // Member management
  MEMBERS_INVITE: 'members:invite',
  MEMBERS_MANAGE: 'members:manage',

  // Organization settings
  SETTINGS_READ: 'settings:read',
  SETTINGS_WRITE: 'settings:write',

  // Billing
  BILLING_READ: 'billing:read',
  BILLING_MANAGE: 'billing:manage',
} as const;

export type OrgPermissionType = (typeof OrgPermission)[keyof typeof OrgPermission];

/**
 * Organization roles
 */
export const orgRoleSchema = z.enum(['owner', 'admin', 'member', 'viewer']);
export type OrgRole = z.infer<typeof orgRoleSchema>;

/**
 * Role hierarchy for comparison
 */
export const OrgRoleHierarchy = {
  owner: 100,
  admin: 75,
  member: 50,
  viewer: 25,
} satisfies Record<OrgRole, number>;

/**
 * Mapping of roles to their permissions
 */
export const OrgRolePermissions = {
  owner: Object.values(OrgPermission),
  admin: [
    OrgPermission.ARTICLES_READ,
    OrgPermission.ARTICLES_WRITE,
    OrgPermission.ARTICLES_DELETE,
    OrgPermission.MEMBERS_INVITE,
    OrgPermission.MEMBERS_MANAGE,
    OrgPermission.SETTINGS_READ,
    OrgPermission.SETTINGS_WRITE,
    OrgPermission.BILLING_READ,
  ],
  member: [
    OrgPermission.ARTICLES_READ,
    OrgPermission.ARTICLES_WRITE,
    OrgPermission.SETTINGS_READ,
  ],
  viewer: [OrgPermission.ARTICLES_READ, OrgPermission.SETTINGS_READ],
} satisfies Record<OrgRole, OrgPermissionType[]>;

/**
 * Get permissions for a given role
 */
export function getPermissionsForRole(role: OrgRole): OrgPermissionType[] {
  return OrgRolePermissions[role] || [];
}

/**
 * Check if a role has a specific permission
 */
export function roleHasPermission(role: OrgRole, permission: OrgPermissionType): boolean {
  const permissions: readonly OrgPermissionType[] = OrgRolePermissions[role] ?? [];
  return permissions.includes(permission);
}

/**
 * Check if roleA has at least the same level as roleB
 */
export function hasMinimumRole(userRole: OrgRole, requiredRole: OrgRole): boolean {
  return OrgRoleHierarchy[userRole] >= OrgRoleHierarchy[requiredRole];
}
