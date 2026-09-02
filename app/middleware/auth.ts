import type { MiddlewareFunction } from 'react-router';
import { redirect } from 'react-router';
import { sessionStorage } from '#app/services/session.server';
import { userContext } from './context';
import { db } from '#drizzle/db';
import { users } from '#drizzle/schema';
import { eq } from 'drizzle-orm';

/**
 * Authentication middleware that runs before route loaders/actions
 * Validates session and provides user context to routes
 */
export const authMiddleware: MiddlewareFunction = async ({ request, context }) => {
  const session = await sessionStorage.getSession(request.headers.get('cookie'));
  const sessionUser = session.get('user');

  if (!sessionUser) {
    throw redirect('/login');
  }

  // Verify user still exists and is not deactivated
  const dbUser = await db.query.users.findFirst({
    where: eq(users.id, sessionUser.id),
  });

  if (!dbUser || dbUser.deactivated) {
    throw redirect('/login', {
      headers: { 'Set-Cookie': await sessionStorage.destroySession(session) },
    });
  }

  // Create a combined user object for context
  // We use the DB user for fresh data but keep session memberships
  const user = {
    ...dbUser,
    memberships: sessionUser.memberships,
    currentOrgId: sessionUser.currentOrgId,
    currentOrgSlug: sessionUser.currentOrgSlug,
  };

  context.set(userContext, user);
};

/**
 * Middleware that requires user to be a superadmin
 */
export const superadminMiddleware: MiddlewareFunction = async ({ context }) => {
  const user = context.get(userContext);

  if (!user?.isSuperadmin) {
    throw redirect('/select-org');
  }
};
