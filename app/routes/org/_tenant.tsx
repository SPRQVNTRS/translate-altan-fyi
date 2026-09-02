import { Outlet } from 'react-router';
import { tenantMiddleware } from '#app/middleware/tenant';

/**
 * Tenant layout that validates org membership and exposes tenant context to
 * nested loaders/actions via `getTenant(context)`. Routes wanting tenant-scoped
 * DB access call `tenantDb({ orgId: tenant.orgId })` from `#drizzle/tenant-db`.
 *
 * All routes under /org/:orgSlug/* go through this layout.
 */
export const middleware = [tenantMiddleware];

export default function TenantLayout() {
  return <Outlet />;
}
