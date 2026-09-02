import type { SelectUser as User, InsertUser } from '#drizzle/schema';
import type { SessionUser } from '#app/types/session';
import { z } from 'zod';
// eslint-disable-next-line no-restricted-imports
import bcrypt from 'bcryptjs';
// eslint-disable-next-line no-restricted-imports
import { Authenticator } from 'remix-auth';
// eslint-disable-next-line no-restricted-imports
import { FormStrategy } from 'remix-auth-form';
import { createUser, getUserByEmail } from '#app/models/users.server';
import { getUserMembershipsForSession } from '#app/models/organizations.server';

/** Credentials the login form must submit. */
const credentialsSchema = z.object({
  email: z.string().min(1, 'email must not be empty'),
  password: z.string().min(1, 'password must not be empty'),
});

// Create an instance of the authenticator, pass a generic with what
// strategies will return and will store in the session
export const authenticator = new Authenticator<SessionUser>();

// Tell the Authenticator to use the form strategy
authenticator.use(
  new FormStrategy(async ({ form }) => {
    const credentials = credentialsSchema.parse(Object.fromEntries(form));
    return await login(credentials);
  }),
  // each strategy has a name and can be changed to use another one
  // same strategy multiple times, especially useful for the OAuth2 strategy.
  'user-pass',
);

/**
 * Authenticate user and load their organization memberships
 */
export async function login({
  email,
  password,
}: {
  email: string;
  password: string;
}): Promise<SessionUser> {
  const user = await getUserByEmail(email);
  if (!user) {
    throw new Error('Incorrect Login');
  }

  if (user.deactivated) {
    throw new Error('Account Deactivated');
  }

  const isValid = await bcrypt.compare(password, user.password);

  if (!isValid) {
    throw new Error('Incorrect Login');
  }

  // Load organization memberships for session
  const memberships = await getUserMembershipsForSession(user.id);

  // Build session user with membership data
  const sessionUser: SessionUser = {
    id: user.id,
    email: user.email,
    name: user.name,
    isSuperadmin: user.isSuperadmin,
    memberships,
    currentOrgId: memberships.length > 0 ? memberships[0].orgId : null,
    currentOrgSlug: memberships.length > 0 ? memberships[0].orgSlug : null,
  };

  return sessionUser;
}

/**
 * Convert a database user to a session user (for refreshing session)
 */
export async function userToSessionUser(user: User): Promise<SessionUser> {
  const memberships = await getUserMembershipsForSession(user.id);

  return {
    id: user.id,
    email: user.email,
    name: user.name,
    isSuperadmin: user.isSuperadmin,
    memberships,
    currentOrgId: memberships.length > 0 ? memberships[0].orgId : null,
    currentOrgSlug: memberships.length > 0 ? memberships[0].orgSlug : null,
  };
}

export async function register(user: InsertUser) {
  const exists = await getUserByEmail(user.email);
  if (exists) {
    return { error: `User already exists with that email` };
  }

  const newUser = await createUser(user);
  if (!newUser) {
    return {
      error: `Something went wrong trying to create a new user.`,
      fields: { email: user.email, password: user.password },
    };
  }
}
