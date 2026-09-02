import type { SelectUser as User, InsertUser } from '#drizzle/schema';
import { users } from '#drizzle/schema';
import { db } from '#drizzle/db';
import { eq } from 'drizzle-orm';
// eslint-disable-next-line no-restricted-imports
import bcrypt from 'bcryptjs';

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

export async function createUser(user: InsertUser) {
  const passwordHash = await bcrypt.hash(user.password, 10);
  const [newUser] = await db
    .insert(users)
    .values({
      email: user.email,
      name: user.name,
      password: passwordHash,
      role: user.role,
    })
    .returning();

  return { id: newUser.id, email: newUser.email };
}

export async function updateUser({ id, data }: { id: number; data: Partial<User> }) {
  return db.update(users).set(data).where(eq(users.id, id)).returning();
}

export async function updateUserByEmail({ email, data }: { email: string; data: Partial<User> }) {
  const [user] = await db.update(users).set(data).where(eq(users.email, email)).returning();

  return user;
}
