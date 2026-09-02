/**
 * User admin model — superadmin HTTP API data access functions.
 *
 * Uses getRawDb() because users is a global table (not tenant-scoped).
 * All functions here are for superadmin-only API endpoints.
 *
 * NOTE: The existing app/models/users.server.ts uses db from #drizzle/db
 * and is used by auth flows. This module is for the admin REST API only.
 */

import { users } from '#drizzle/schema';
import type { SelectUser } from '#drizzle/schema';
import { getRawDb } from '#drizzle/tenant-db';
import { eq, and, asc, count, type SQL } from 'drizzle-orm';
import type { PaginationParams } from '#app/lib/pagination.server';

export type SafeUser = Omit<SelectUser, 'password'>;

export function stripPassword(user: SelectUser): SafeUser {
  const { password: _p, ...safe } = user;
  return safe;
}

export interface ListUsersFilters {
  active?: boolean;
  deactivated?: boolean;
  superadmin?: boolean;
}

export async function listUsersAdmin(
  filters: ListUsersFilters,
  pagination: PaginationParams = { limit: 20, offset: 0 },
): Promise<{ rows: SafeUser[]; total: number }> {
  const conditions: SQL[] = [];
  if (filters.active) {
    conditions.push(eq(users.deactivated, false));
  }
  if (filters.deactivated) {
    conditions.push(eq(users.deactivated, true));
  }
  if (filters.superadmin) {
    conditions.push(eq(users.isSuperadmin, true));
  }

  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const [rows, totalRow] = await Promise.all([
    getRawDb()
      .select()
      .from(users)
      .where(where)
      .orderBy(asc(users.id))
      .limit(pagination.limit)
      .offset(pagination.offset),
    getRawDb()
      .select({ value: count() })
      .from(users)
      .where(where)
      .then((r) => r[0]),
  ]);

  return { rows: rows.map(stripPassword), total: Number(totalRow?.value ?? 0) };
}

export async function getUserByIdAdmin(id: number): Promise<SafeUser | null> {
  const [user] = await getRawDb()
    .select()
    .from(users)
    .where(eq(users.id, id))
    .limit(1);
  return user ? stripPassword(user) : null;
}

export async function getUserByEmailAdmin(email: string): Promise<SafeUser | null> {
  const [user] = await getRawDb()
    .select()
    .from(users)
    .where(eq(users.email, email))
    .limit(1);
  return user ? stripPassword(user) : null;
}

export interface PatchUserFields {
  deactivated?: boolean;
  isSuperadmin?: boolean;
}

export async function patchUserAdmin(id: number, fields: PatchUserFields): Promise<SafeUser | null> {
  const updated = await getRawDb()
    .update(users)
    .set(fields)
    .where(eq(users.id, id))
    .returning();
  const user = updated[0];
  return user ? stripPassword(user) : null;
}
