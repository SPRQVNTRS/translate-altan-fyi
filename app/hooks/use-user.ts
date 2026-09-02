import { useRouteLoaderData } from 'react-router';
import type { SelectUser as User } from '#drizzle/schema';

/**
 * Hook to access authenticated user from root loader
 * Must be used within routes protected by authMiddleware
 * @returns User object
 * @throws Error if user is not found
 */
export function useUser(): User {
  const data = useRouteLoaderData<{ user: User | null }>('root');
  if (!data?.user) {
    throw new Error('useUser must be used within a route protected by authMiddleware');
  }
  return data.user;
}

/**
 * Hook to optionally access authenticated user from root loader
 * Can be used in public routes where user may or may not be authenticated
 * @returns User object or null if not authenticated
 */
export function useOptionalUser(): User | null {
  const data = useRouteLoaderData<{ user: User | null }>('root');
  return data?.user ?? null;
}
