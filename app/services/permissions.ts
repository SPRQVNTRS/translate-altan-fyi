import type { SelectUser as User } from '#drizzle/schema';
import type { RoleType } from '#drizzle/types/enums';

/**
 * Role hierarchy for permission checks.
 * Higher number = more permissions.
 */
const ROLE_HIERARCHY = {
  admin: 100,
  manager: 50,
  editor: 10,
} satisfies Record<RoleType, number>;

/**
 * Check if user has admin role.
 */
export function userIsAdmin(user: User | null): boolean {
  return user?.role === 'admin';
}

/**
 * Check if user has manager role or higher (admin).
 */
export function userIsManager(user: User | null): boolean {
  return user?.role === 'admin' || user?.role === 'manager';
}

/**
 * Check if user has any of the specified roles.
 */
export function userHasRole(user: User | null, ...roles: RoleType[]): boolean {
  if (!user?.role) return false;
  return roles.includes(user.role);
}

/**
 * Check if user has at least the specified role level.
 * Uses role hierarchy: admin > manager > editor
 */
export function userHasMinimumRole(user: User | null, minimumRole: RoleType): boolean {
  if (!user?.role) return false;
  return ROLE_HIERARCHY[user.role] >= ROLE_HIERARCHY[minimumRole];
}

/**
 * Assert that user has admin role, throwing an error if not.
 * Use in actions/loaders for defense-in-depth after middleware.
 */
export function assertAdmin(user: User | null): asserts user is User & { role: 'admin' } {
  if (!userIsAdmin(user)) {
    throw new Response('Forbidden', { status: 403 });
  }
}

/**
 * Assert that user has manager role or higher, throwing an error if not.
 * Use in actions/loaders for defense-in-depth after middleware.
 */
export function assertManager(user: User | null): asserts user is User & { role: 'admin' | 'manager' } {
  if (!userIsManager(user)) {
    throw new Response('Forbidden', { status: 403 });
  }
}
