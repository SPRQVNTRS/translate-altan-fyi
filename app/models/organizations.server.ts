import { eq, and } from 'drizzle-orm';
import { db } from '#drizzle/db';
import {
  organizations,
  organizationMembers,
  type InsertOrganization,
  type InsertOrganizationMember,
  type SelectOrganization,
} from '#drizzle/schema';
import { getPermissionsForRole, orgRoleSchema, type OrgRole } from '#app/types/permissions';
import type { OrgMembership } from '#app/types/session';

/**
 * Get all organizations
 */
export async function getOrganizations() {
  return db.query.organizations.findMany({
    orderBy: (orgs, { asc }) => [asc(orgs.name)],
  });
}

/**
 * Get organization by ID
 */
export async function getOrganizationById(id: string) {
  return db.query.organizations.findFirst({
    where: eq(organizations.id, id),
  });
}

/**
 * Get organization by slug
 */
export async function getOrganizationBySlug(slug: string) {
  return db.query.organizations.findFirst({
    where: eq(organizations.slug, slug),
  });
}

/**
 * Create a new organization
 */
export async function createOrganization(data: InsertOrganization) {
  const [org] = await db.insert(organizations).values(data).returning();
  return org;
}

/**
 * Update an organization
 */
export async function updateOrganization(id: string, data: Partial<InsertOrganization>) {
  const [org] = await db
    .update(organizations)
    .set(data)
    .where(eq(organizations.id, id))
    .returning();
  return org;
}

/**
 * Delete an organization
 */
export async function deleteOrganization(id: string) {
  await db.delete(organizations).where(eq(organizations.id, id));
}

/**
 * Get organization members
 */
export async function getOrganizationMembers(orgId: string) {
  return db.query.organizationMembers.findMany({
    where: eq(organizationMembers.organizationId, orgId),
    with: {
      user: true,
    },
  });
}

/**
 * Add a member to an organization
 */
export async function addOrganizationMember(data: InsertOrganizationMember) {
  const [member] = await db.insert(organizationMembers).values(data).returning();
  return member;
}

/**
 * Update a member's role
 */
export async function updateOrganizationMemberRole(
  orgId: string,
  userId: number,
  role: OrgRole,
) {
  const [member] = await db
    .update(organizationMembers)
    .set({ role })
    .where(
      and(
        eq(organizationMembers.organizationId, orgId),
        eq(organizationMembers.userId, userId),
      ),
    )
    .returning();
  return member;
}

/**
 * Remove a member from an organization
 */
export async function removeOrganizationMember(orgId: string, userId: number) {
  await db
    .delete(organizationMembers)
    .where(
      and(
        eq(organizationMembers.organizationId, orgId),
        eq(organizationMembers.userId, userId),
      ),
    );
}

/**
 * Get a user's membership in an organization
 */
export async function getUserOrganizationMembership(userId: number, orgId: string) {
  return db.query.organizationMembers.findFirst({
    where: and(
      eq(organizationMembers.userId, userId),
      eq(organizationMembers.organizationId, orgId),
    ),
    with: {
      organization: true,
    },
  });
}

/**
 * Get all organizations a user is a member of
 */
export async function getUserOrganizations(userId: number) {
  return db.query.organizationMembers.findMany({
    where: eq(organizationMembers.userId, userId),
    with: {
      organization: true,
    },
  });
}

/**
 * Get user's organization memberships formatted for session storage
 */
export async function getUserMembershipsForSession(userId: number): Promise<OrgMembership[]> {
  const memberships = await getUserOrganizations(userId);

  return memberships.map((m) => {
    // `organization_members.role` is a plain text column; decode it into the
    // domain role, falling back to the least-privileged role on an unknown value.
    const role = orgRoleSchema.catch('viewer').parse(m.role);
    return {
      orgId: m.organization.id,
      orgSlug: m.organization.slug,
      orgName: m.organization.name,
      role,
      permissions: getPermissionsForRole(role),
    };
  });
}

/**
 * Create an organization with the creator as owner
 */
export async function createOrganizationWithOwner(
  data: InsertOrganization,
  ownerId: number,
): Promise<SelectOrganization> {
  const [org] = await db.insert(organizations).values(data).returning();

  await db.insert(organizationMembers).values({
    organizationId: org.id,
    userId: ownerId,
    role: 'owner',
  });

  return org;
}

/**
 * Generate a unique slug from a name
 */
export function generateSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .substring(0, 50);
}

/**
 * Check if a slug is available
 */
export async function isSlugAvailable(slug: string): Promise<boolean> {
  const existing = await getOrganizationBySlug(slug);
  return !existing;
}
