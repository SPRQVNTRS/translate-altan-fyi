/**
 * `users` reads and writes.
 *
 * THERE IS NO PASSWORD HERE ANY MORE, AND THERE MUST NEVER BE ONE AGAIN.
 * Authentication moved to `accounts`: a passphrase never reaches the server,
 * what is stored is `HMAC(pepper, authHash)` on `accounts.verifier`, and the
 * `users.password` column is gone. `users` survives for the ORG and API-KEY
 * surface only — memberships, roles and api keys are keyed on `users.id` and
 * none of that moved. `users.accountId` is the join back to the identity.
 *
 * Adding a credential column here would give this service two authentication
 * systems, one of which the encrypted personal layer cannot see, and would
 * re-create the bcrypt path ADR-0008's account model replaced.
 */
import type { SelectUser as User, InsertUser } from '#drizzle/schema';
import { users } from '#drizzle/schema';
import { db } from '#drizzle/db';
import { eq } from 'drizzle-orm';

export async function getUsers() {
  return db.query.users.findMany();
}

export async function getUserById(id: number) {
  return db.query.users.findFirst({
    where: eq(users.id, id),
  });
}

export async function getUserByEmail(email: string | null) {
  if (!email) return null;
  const user = await db.query.users.findFirst({
    where: eq(users.email, email),
  });
  return user;
}

/**
 * Creates an org-surface `users` row.
 *
 * IT CREATES NO CREDENTIAL. Whoever this row belongs to authenticates as an
 * `accounts` row; link the two by setting `accountId`, which is what
 * `authMiddleware` joins on.
 *
 * @param user the row to insert. It carries no password, by construction.
 * @returns the new row's id and email.
 */
export async function createUser(user: InsertUser): Promise<{ id: number; email: string }> {
  const [newUser] = await db
    .insert(users)
    .values({
      email: user.email,
      name: user.name,
      role: user.role,
      accountId: user.accountId ?? null,
    })
    .returning();

  if (!newUser) throw new Error(`Failed to create the user row for ${user.email}`);
  return { id: newUser.id, email: newUser.email };
}

export async function updateUser({ id, data }: { id: number; data: Partial<User> }) {
  return db.update(users).set(data).where(eq(users.id, id)).returning();
}

export async function updateUserByEmail({ email, data }: { email: string; data: Partial<User> }) {
  const [user] = await db.update(users).set(data).where(eq(users.email, email)).returning();

  return user;
}
