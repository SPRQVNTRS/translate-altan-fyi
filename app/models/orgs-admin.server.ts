/**
 * Organization admin model — superadmin HTTP API data access functions.
 *
 * Uses getRawDb() because organizations is a global table (not tenant-scoped).
 * All functions here are for superadmin-only API endpoints.
 *
 * NOTE: The existing app/models/organizations.server.ts uses db from #drizzle/db
 * and is used by auth/session flows. This module is for the admin REST API only.
 */

import { organizations, organizationMembers, users } from '#drizzle/schema';
import type { SelectOrganization, SelectOrganizationMember } from '#drizzle/schema';
import { getRawDb } from '#drizzle/tenant-db';
import { eq, asc, count } from 'drizzle-orm';
import type { PaginationParams } from '#app/lib/pagination.server';
import { z } from 'zod';

export interface MemberWithUser extends SelectOrganizationMember {
  user: { id: number; name: string; email: string };
}

export async function listOrgsAdmin(
  pagination: PaginationParams = { limit: 20, offset: 0 },
): Promise<{ rows: SelectOrganization[]; total: number }> {
  const [rows, totalRow] = await Promise.all([
    getRawDb()
      .select()
      .from(organizations)
      .orderBy(asc(organizations.name))
      .limit(pagination.limit)
      .offset(pagination.offset),
    getRawDb()
      .select({ value: count() })
      .from(organizations)
      .then((r) => r[0]),
  ]);
  return { rows, total: Number(totalRow?.value ?? 0) };
}

export async function getOrgByIdOrSlug(idOrSlug: string): Promise<SelectOrganization | null> {
  // Try slug first (shorter, more common in CLI usage)
  const [bySlug] = await getRawDb()
    .select()
    .from(organizations)
    .where(eq(organizations.slug, idOrSlug))
    .limit(1);
  if (bySlug) return bySlug;

  // Fall back to the UUID id. Postgres raises `invalid input syntax for type
  // uuid` on a non-UUID comparison, so a slug that matched nothing must not
  // reach the query — it is simply a miss.
  if (!z.uuid().safeParse(idOrSlug).success) return null;

  const [byId] = await getRawDb()
    .select()
    .from(organizations)
    .where(eq(organizations.id, idOrSlug))
    .limit(1);
  return byId ?? null;
}

export async function getOrgMembersAdmin(
  orgId: string,
  pagination: PaginationParams = { limit: 20, offset: 0 },
): Promise<{ rows: MemberWithUser[]; total: number }> {
  const where = eq(organizationMembers.organizationId, orgId);
  const [rows, totalRow] = await Promise.all([
    getRawDb()
      .select({
        id: organizationMembers.id,
        organizationId: organizationMembers.organizationId,
        userId: organizationMembers.userId,
        role: organizationMembers.role,
        joinedAt: organizationMembers.joinedAt,
        user: {
          id: users.id,
          name: users.name,
          email: users.email,
        },
      })
      .from(organizationMembers)
      .innerJoin(users, eq(organizationMembers.userId, users.id))
      .where(where)
      .limit(pagination.limit)
      .offset(pagination.offset),
    getRawDb()
      .select({ value: count() })
      .from(organizationMembers)
      .where(where)
      .then((r) => r[0]),
  ]);
  return { rows, total: Number(totalRow?.value ?? 0) };
}

export async function deleteOrgAdmin(orgId: string): Promise<void> {
  await getRawDb().delete(organizations).where(eq(organizations.id, orgId));
}

export async function countOrgMembersAdmin(orgId: string): Promise<number> {
  const rows = await getRawDb()
    .select({ id: organizationMembers.id })
    .from(organizationMembers)
    .where(eq(organizationMembers.organizationId, orgId));
  return rows.length;
}
