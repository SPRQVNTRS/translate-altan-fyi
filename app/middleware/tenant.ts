import type { MiddlewareFunction } from 'react-router';
import { redirect } from 'react-router';
import { eq } from 'drizzle-orm';
import { db } from '#drizzle/db';
import { organizations } from '#drizzle/schema';
import { OrgPermission, getPermissionsForRole, orgRoleSchema, type OrgPermissionType, type OrgRole } from '#app/types/permissions';
import type { TenantContextValue } from '#app/types/session';
import { getUser } from './helpers';
import { tenantContext, orgContext } from './context';

/**
 * Tenant middleware that extracts and validates organization context from URL.
 * Must be used AFTER authMiddleware.
 *
 * Expects routes like: /org/:orgSlug/dashboard
 *
 * For superadmins: Allows access to any organization
 * For regular users: Validates membership from cached session data
 */
export const tenantMiddleware: MiddlewareFunction = async ({ context, params }) => {
  const user = getUser(context);
  const { orgSlug } = params;

  if (!orgSlug) {
    throw redirect('/select-org');
  }

  // Superadmins can access any organization
  if (user.isSuperadmin) {
    const org = await db.query.organizations.findFirst({
      where: eq(organizations.slug, orgSlug),
    });

    if (!org) {
      throw redirect('/select-org');
    }

    const tenantCtx: TenantContextValue = {
      userId: user.id,
      orgId: org.id,
      orgSlug: org.slug,
      orgRole: 'owner', // Superadmins have owner-level access
      permissions: Object.values(OrgPermission),
      isSuperadmin: true,
    };

    context.set(tenantContext, tenantCtx);
    context.set(orgContext, org);
    return;
  }

  // Regular users: Look up membership for the specific org from database
  // First find the org, then check membership
  const org = await db.query.organizations.findFirst({
    where: eq(organizations.slug, orgSlug),
  });

  if (!org) {
    throw redirect('/dashboard');
  }

  const membership = await db.query.organizationMembers.findFirst({
    where: (members, { and, eq: eqOp }) =>
      and(eqOp(members.userId, user.id), eqOp(members.organizationId, org.id)),
  });

  if (!membership) {
    // User is not a member of this organization
    throw redirect('/select-org');
  }

  // `organization_members.role` is a plain text column; unknown values fall
  // back to the least-privileged role.
  const role = orgRoleSchema.catch('viewer').parse(membership.role);
  const permissions = getPermissionsForRole(role);

  const tenantCtx: TenantContextValue = {
    userId: user.id,
    orgId: org.id,
    orgSlug: org.slug,
    orgRole: role,
    permissions,
    isSuperadmin: false,
  };

  context.set(tenantContext, tenantCtx);
  context.set(orgContext, org);
};

/**
 * Get tenant context from route context
 */
export function getTenant(
  context: Parameters<MiddlewareFunction>[0]['context'],
): TenantContextValue {
  const tenant = context.get(tenantContext);
  if (!tenant) {
    throw new Error('Tenant context not found. Use tenantMiddleware first.');
  }
  return tenant;
}

/**
 * Creates middleware that requires specific org permissions.
 * Must be used AFTER tenantMiddleware.
 */
export function requireOrgPermission(
  ...requiredPermissions: OrgPermissionType[]
): MiddlewareFunction {
  return async ({ context }) => {
    const tenant = context.get(tenantContext);

    if (!tenant) {
      throw new Error('tenantContext not found. Use tenantMiddleware first.');
    }

    // Superadmins bypass permission checks
    if (tenant.isSuperadmin) {
      return;
    }

    const hasAll = requiredPermissions.every((p) => tenant.permissions.includes(p));

    if (!hasAll) {
      throw redirect(`/org/${tenant.orgSlug}/dashboard`);
    }
  };
}

/**
 * Creates middleware that requires a minimum org role.
 * Must be used AFTER tenantMiddleware.
 */
export function requireOrgRole(...allowedRoles: OrgRole[]): MiddlewareFunction {
  return async ({ context }) => {
    const tenant = context.get(tenantContext);

    if (!tenant) {
      throw new Error('tenantContext not found. Use tenantMiddleware first.');
    }

    // Superadmins bypass role checks
    if (tenant.isSuperadmin) {
      return;
    }

    if (!allowedRoles.includes(tenant.orgRole)) {
      throw redirect(`/org/${tenant.orgSlug}/dashboard`);
    }
  };
}

// Pre-built permission middlewares
export const canReadArticles = requireOrgPermission(OrgPermission.ARTICLES_READ);
export const canWriteArticles = requireOrgPermission(OrgPermission.ARTICLES_WRITE);
export const canDeleteArticles = requireOrgPermission(OrgPermission.ARTICLES_DELETE);
export const canInviteMembers = requireOrgPermission(OrgPermission.MEMBERS_INVITE);
export const canManageMembers = requireOrgPermission(OrgPermission.MEMBERS_MANAGE);
export const canReadSettings = requireOrgPermission(OrgPermission.SETTINGS_READ);
export const canWriteSettings = requireOrgPermission(OrgPermission.SETTINGS_WRITE);
export const canReadBilling = requireOrgPermission(OrgPermission.BILLING_READ);
export const canManageBilling = requireOrgPermission(OrgPermission.BILLING_MANAGE);

// Pre-built role middlewares
export const requireOwner = requireOrgRole('owner');
export const requireAdmin = requireOrgRole('owner', 'admin');
export const requireMember = requireOrgRole('owner', 'admin', 'member');
