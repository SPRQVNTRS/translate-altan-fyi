import { useRouteLoaderData } from 'react-router';
import type { OrgRoleType } from '#drizzle/types/enums';

interface TenantData {
  orgId: string;
  orgSlug: string;
  orgRole: OrgRoleType | null;
  isSuperadmin: boolean;
}

/**
 * Hook to access tenant context from org layout loader.
 * Must be used within /org/:orgSlug/* routes.
 * @returns Tenant data object
 * @throws Error if tenant data is not found
 */
export function useTenant(): TenantData {
  const data = useRouteLoaderData<{ tenant: TenantData | null }>('_org_layout');
  if (!data?.tenant) {
    throw new Error('useTenant must be used within /org/:orgSlug/* routes');
  }
  return data.tenant;
}

/**
 * Hook to optionally access tenant context.
 * Can be used in routes that may or may not have org context.
 * @returns Tenant data object or null
 */
export function useOptionalTenant(): TenantData | null {
  const data = useRouteLoaderData<{ tenant: TenantData | null }>('_org_layout');
  return data?.tenant ?? null;
}

/**
 * Check if user is an org admin (owner or admin role).
 */
export function isOrgAdmin(orgRole: OrgRoleType | null | undefined): boolean {
  return orgRole === 'owner' || orgRole === 'admin';
}
