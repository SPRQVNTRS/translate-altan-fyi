import type { MiddlewareFunction } from 'react-router';
import { redirect } from 'react-router';
import type { RoleType } from '#drizzle/types/enums';
import { getUser } from './helpers';

/**
 * Creates middleware that requires specific roles.
 * Must be used AFTER authMiddleware (user must already be in context).
 *
 * @param allowedRoles - Roles that are permitted to access the route
 * @returns Middleware function that validates user role
 *
 * @example
 * // In a route file:
 * export const middleware = [requireRole('admin')];
 *
 * @example
 * // Multiple roles:
 * export const middleware = [requireRole('admin', 'manager')];
 */
export function requireRole(...allowedRoles: RoleType[]): MiddlewareFunction {
  return async ({ context }) => {
    const user = getUser(context);

    if (!allowedRoles.includes(user.role)) {
      throw redirect('/dashboard');
    }
  };
}

/**
 * Middleware that requires admin role.
 * Use this for admin-only routes.
 */
export const adminMiddleware = requireRole('admin');

/**
 * Middleware that requires manager or admin role.
 * Use this for routes accessible to managers and above.
 */
export const managerMiddleware = requireRole('admin', 'manager');
