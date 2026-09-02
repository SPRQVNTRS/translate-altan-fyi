import { Outlet } from 'react-router';
import { requireAdmin } from '#app/middleware/tenant';

/**
 * Layout for org-level admin routes.
 * Requires the user to have owner or admin role in the org.
 */
export const middleware = [requireAdmin];

export default function OrgAdminLayout() {
  return <Outlet />;
}
