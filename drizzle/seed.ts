// eslint-disable-next-line no-restricted-imports
import bcrypt from 'bcryptjs';
import { users, pages, organizations, organizationMembers } from './schema';
import { db, client } from './db';
import { eq } from 'drizzle-orm';
import 'dotenv/config';

const SEED_PASSWORD = 'password';

const SEED_USERS = [
  {
    email: process.env.SUPERADMIN_EMAIL || 'superadmin@example.com',
    name: 'Super Admin',
    role: 'admin' as const,
    isSuperadmin: true,
    orgRole: null,
  },
  {
    email: 'orgowner@example.com',
    name: 'Org Owner',
    role: 'admin' as const,
    isSuperadmin: false,
    orgRole: 'owner' as const,
  },
  {
    email: 'orgadmin@example.com',
    name: 'Org Admin',
    role: 'admin' as const,
    isSuperadmin: false,
    orgRole: 'admin' as const,
  },
  {
    email: 'orguser@example.com',
    name: 'Org User',
    role: 'editor' as const,
    isSuperadmin: false,
    orgRole: 'member' as const,
  },
  {
    email: 'viewer@example.com',
    name: 'Viewer',
    role: 'editor' as const,
    isSuperadmin: false,
    orgRole: 'viewer' as const,
  },
] as const;

async function main() {
  try {
    console.log(`Seeding database...`);
    const passwordHash = await bcrypt.hash(process.env.SUPERADMIN_PASSWORD || SEED_PASSWORD, 10);

    // Create default organization
    const [org] = await db
      .insert(organizations)
      .values({
        name: 'Default Organization',
        slug: 'default',
      })
      .onConflictDoNothing()
      .returning();

    const orgId = org?.id ?? (await db.query.organizations.findFirst({
      where: eq(organizations.slug, 'default'),
    }))?.id;

    if (!orgId) {
      throw new Error('Failed to create or find default organization');
    }

    // Create users
    for (const seedUser of SEED_USERS) {
      const [created] = await db
        .insert(users)
        .values({
          email: seedUser.email,
          name: seedUser.name,
          password: passwordHash,
          role: seedUser.role,
          isSuperadmin: seedUser.isSuperadmin,
        })
        .onConflictDoNothing()
        .returning();

      if (created && seedUser.orgRole) {
        await db
          .insert(organizationMembers)
          .values({
            userId: created.id,
            organizationId: orgId,
            role: seedUser.orgRole,
          })
          .onConflictDoNothing();
      }

      if (created) {
        const label = seedUser.isSuperadmin
          ? 'superadmin'
          : `org ${seedUser.orgRole}`;
        console.log(`Created ${label}: ${created.email}`);
      }
    }

    // Create sample page
    await db
      .insert(pages)
      .values({
        title: 'About',
        slug: 'about',
        content: 'Welcome to the about page',
        organizationId: orgId,
      })
      .onConflictDoNothing();

    console.log(`Database seeded successfully.`);
  } catch (error) {
    console.error("Error checking or creating database:", error);
  } finally {
    await client.end();
  }
}

main();
