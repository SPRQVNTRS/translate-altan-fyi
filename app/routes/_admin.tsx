import { Outlet } from 'react-router';
import { adminMiddleware } from '#app/middleware/roles';

/**
 * Admin layout that protects all nested routes.
 * Only users with the 'admin' role can access routes under this layout.
 *
 * Routes nested under this layout:
 * - /users
 * - (future admin routes)
 */
export const middleware = [adminMiddleware];

export default function AdminLayout() {
  return <Outlet />;
}
