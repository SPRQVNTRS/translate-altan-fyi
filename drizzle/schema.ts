import type { RoleType, OrgRoleType } from '#drizzle/types/enums';
import { relations, type InferInsertModel, type InferSelectModel } from 'drizzle-orm';
import {
  pgTable,
  serial,
  text,
  integer,
  timestamp,
  jsonb,
  uniqueIndex,
  index,
  boolean,
  uuid,
  unique,
} from 'drizzle-orm/pg-core';

// Workflow tables from the orchestrator package.
// These have no organizationId column — host-app code that needs tenant scope
// filters via the JSONB `context->>'organizationId'` field.
import {
  workflows as _workflows,
  workflowOperations as _workflowOperations,
  workflowLocks as _workflowLocks,
} from '@sprqvntrs/workflows/schema';

export const workflows = _workflows;
export const workflowOperations = _workflowOperations;
export const workflowLocks = _workflowLocks;

// Shared dictionary tables (headwords, senses, translations, ...).
// Global, NOT tenant-scoped: none of them belongs in TENANT_TABLES.
// Re-exported here because this file is the single entry point that
// `drizzle/db.ts` and `drizzle.config.ts` both read.
export * from './schema/dictionary';

// Global application settings (app_settings, app_settings_audit).
// Also NOT tenant-scoped, and re-exported here for the same reason.
export * from './schema/settings';

// =============================================================================
// Organizations (Multi-Tenancy Core)
// =============================================================================
// Tenant isolation is enforced in application code via `tenantDb(ctx)` from
// `#drizzle/tenant-db`, NOT via Postgres RLS. See .adr/0003-app-enforced-multi-tenancy.md.

export const organizations = pgTable(
  'organizations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    slug: text('slug').notNull().unique(),
    settings: jsonb('settings').default({}).notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at')
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [uniqueIndex('organizations_slug_idx').on(table.slug)],
);

export type InsertOrganization = InferInsertModel<typeof organizations>;
export type SelectOrganization = InferSelectModel<typeof organizations>;

export const organizationsRelations = relations(organizations, ({ many }) => ({
  members: many(organizationMembers),
  articles: many(articles),
  pages: many(pages),
  categories: many(categories),
  workflows: many(workflows),
  metricEvents: many(metricEvents),
  apiKeys: many(apiKeys),
  dataSources: many(dataSources),
}));

// =============================================================================
// Organization Members (Junction Table with Roles)
// =============================================================================

export const organizationMembers = pgTable(
  'organization_members',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: text('role').$type<OrgRoleType>().notNull().default('member'),
    joinedAt: timestamp('joined_at').defaultNow().notNull(),
  },
  (table) => [
    unique('org_members_unique').on(table.organizationId, table.userId),
    index('org_members_user_idx').on(table.userId),
    index('org_members_org_idx').on(table.organizationId),
  ],
);

export type InsertOrganizationMember = InferInsertModel<typeof organizationMembers>;
export type SelectOrganizationMember = InferSelectModel<typeof organizationMembers>;

export const organizationMembersRelations = relations(organizationMembers, ({ one }) => ({
  organization: one(organizations, {
    fields: [organizationMembers.organizationId],
    references: [organizations.id],
  }),
  user: one(users, {
    fields: [organizationMembers.userId],
    references: [users.id],
  }),
}));

// =============================================================================
// Users (Global - Not Tenant-Scoped)
// =============================================================================
// Users are global because:
// - Users can belong to multiple organizations
// - Authentication happens before org context is known
// - Superadmins exist outside any tenant

export const users = pgTable('users', {
  id: serial('id').primaryKey(),
  email: text('email').unique().notNull(),
  deactivated: boolean('deactivated').default(false).notNull(),
  name: text('name').notNull(),
  password: text('password').notNull(),
  role: text('role').$type<RoleType>().default('editor').notNull(),
  /** Superadmins operate across all organizations: their code paths use getRawDb() instead of the org-scoped tenantDb(ctx). See .adr/0003-app-enforced-multi-tenancy.md. */
  isSuperadmin: boolean('is_superadmin').default(false).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at')
    .defaultNow()
    .$onUpdate(() => new Date())
    .notNull(),
});

export type InsertUser = InferInsertModel<typeof users>;
export type SelectUser = InferSelectModel<typeof users>;

// =============================================================================
// Tenant-Scoped Content Tables (scoped via tenantDb)
// =============================================================================

export const articles = pgTable(
  'articles',
  {
    id: serial('id').primaryKey(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    slug: text('slug').notNull(),
    content: text('content').notNull(),
    authorId: integer('author_id').references(() => users.id, { onDelete: 'set null' }),
    categoryId: integer('category_id').references(() => categories.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at')
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [
    index('articles_org_idx').on(table.organizationId),
    uniqueIndex('articles_org_slug_idx').on(table.organizationId, table.slug),
  ],
);

export type InsertArticle = InferInsertModel<typeof articles>;
export type SelectArticle = InferSelectModel<typeof articles>;

export const articlesRelations = relations(articles, ({ one }) => ({
  organization: one(organizations, {
    fields: [articles.organizationId],
    references: [organizations.id],
  }),
  author: one(users, {
    fields: [articles.authorId],
    references: [users.id],
  }),
  category: one(categories, {
    fields: [articles.categoryId],
    references: [categories.id],
  }),
}));

export const categories = pgTable(
  'categories',
  {
    id: serial('id').primaryKey(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
  },
  (table) => [index('categories_org_idx').on(table.organizationId)],
);

export type InsertCategory = InferInsertModel<typeof categories>;
export type SelectCategory = InferSelectModel<typeof categories>;

export const categoriesRelations = relations(categories, ({ one, many }) => ({
  organization: one(organizations, {
    fields: [categories.organizationId],
    references: [organizations.id],
  }),
  articles: many(articles),
  pages: many(pages),
}));

export const pages = pgTable(
  'pages',
  {
    id: serial('id').primaryKey(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    slug: text('slug').notNull(),
    content: text('content').notNull(),
    authorId: integer('author_id').references(() => users.id, { onDelete: 'set null' }),
    categoryId: integer('category_id').references(() => categories.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at')
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [
    index('pages_org_idx').on(table.organizationId),
    uniqueIndex('pages_org_slug_idx').on(table.organizationId, table.slug),
  ],
);

export type InsertPage = InferInsertModel<typeof pages>;
export type SelectPage = InferSelectModel<typeof pages>;

export const pagesRelations = relations(pages, ({ one }) => ({
  organization: one(organizations, {
    fields: [pages.organizationId],
    references: [organizations.id],
  }),
  author: one(users, {
    fields: [pages.authorId],
    references: [users.id],
  }),
  category: one(categories, {
    fields: [pages.categoryId],
    references: [categories.id],
  }),
}));

// =============================================================================
// Metric Events (Tenant-Scoped, scoped via tenantDb)
// =============================================================================

export const metricEvents = pgTable(
  'metric_events',
  {
    id: serial('id').primaryKey(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    source: text('source').notNull(),
    eventType: text('event_type').notNull(),
    payload: jsonb('payload').notNull(),
    timestamp: timestamp('timestamp').notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (table) => [
    index('metric_events_org_idx').on(table.organizationId),
    index('metric_events_org_type_ts_idx').on(table.organizationId, table.eventType, table.timestamp),
  ],
);

export type InsertMetricEvent = InferInsertModel<typeof metricEvents>;
export type SelectMetricEvent = InferSelectModel<typeof metricEvents>;

export const metricEventsRelations = relations(metricEvents, ({ one }) => ({
  organization: one(organizations, {
    fields: [metricEvents.organizationId],
    references: [organizations.id],
  }),
}));

// =============================================================================
// API Keys (Tenant-Scoped, scoped via tenantDb)
// =============================================================================

export const apiKeys = pgTable(
  'api_keys',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    prefix: text('prefix').notNull(),
    hash: text('hash').notNull(),
    lastUsedAt: timestamp('last_used_at'),
    expiresAt: timestamp('expires_at'),
    revoked: boolean('revoked').default(false).notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    createdBy: integer('created_by').references(() => users.id, { onDelete: 'set null' }),
  },
  (table) => [
    index('api_keys_org_idx').on(table.organizationId),
    index('api_keys_prefix_idx').on(table.prefix),
  ],
);

export type InsertApiKey = InferInsertModel<typeof apiKeys>;
export type SelectApiKey = InferSelectModel<typeof apiKeys>;

export const apiKeysRelations = relations(apiKeys, ({ one }) => ({
  organization: one(organizations, {
    fields: [apiKeys.organizationId],
    references: [organizations.id],
  }),
  creator: one(users, {
    fields: [apiKeys.createdBy],
    references: [users.id],
  }),
}));

// =============================================================================
// Data Sources (Tenant-Scoped, scoped via tenantDb)
// =============================================================================

export const dataSources = pgTable(
  'data_sources',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    type: text('type').notNull(),
    config: jsonb('config').notNull(),
    schedule: text('schedule').notNull(),
    mapping: jsonb('mapping'),
    enabled: boolean('enabled').default(true).notNull(),
    lastFetchedAt: timestamp('last_fetched_at'),
    lastError: text('last_error'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at')
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [
    uniqueIndex('data_sources_org_slug_idx').on(table.organizationId, table.slug),
    index('data_sources_org_idx').on(table.organizationId),
  ],
);

export type InsertDataSource = InferInsertModel<typeof dataSources>;
export type SelectDataSource = InferSelectModel<typeof dataSources>;

export const dataSourcesRelations = relations(dataSources, ({ one }) => ({
  organization: one(organizations, {
    fields: [dataSources.organizationId],
    references: [organizations.id],
  }),
}));

export const usersRelations = relations(users, ({ many }) => ({
  articles: many(articles),
  pages: many(pages),
  organizationMemberships: many(organizationMembers),
  createdApiKeys: many(apiKeys),
}));


// =============================================================================
// Data Migrations (Global — tracks applied data migrations per environment)
// =============================================================================
// This is a global table — no organizationId. Access only via getRawDb().
// Do NOT add to TENANT_TABLES in drizzle/tenant-db.ts.

export const dataMigrations = pgTable('data_migrations', {
  name: text('name').primaryKey(),
  appliedAt: timestamp('applied_at').defaultNow().notNull(),
});

export type InsertDataMigration = InferInsertModel<typeof dataMigrations>;
export type SelectDataMigration = InferSelectModel<typeof dataMigrations>;
