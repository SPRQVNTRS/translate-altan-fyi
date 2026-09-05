import { type InferInsertModel, type InferSelectModel } from 'drizzle-orm';
import { pgTable, text, timestamp, index, boolean, uuid } from 'drizzle-orm/pg-core';

// Workflow tables from the orchestrator package. Enrichment runs on them.
import {
  workflows as _workflows,
  workflowOperations as _workflowOperations,
  workflowLocks as _workflowLocks,
} from '@sprqvntrs/workflows/schema';

export const workflows = _workflows;
export const workflowOperations = _workflowOperations;
export const workflowLocks = _workflowLocks;

// Shared dictionary tables (headwords, senses, translations, ...).
// Re-exported here because this file is the single entry point that
// `drizzle/db.ts` and `drizzle.config.ts` both read.
export * from './schema/dictionary';

// Global application settings (app_settings, app_settings_audit).
// Also NOT tenant-scoped, and re-exported here for the same reason.
export * from './schema/settings';

// Enrichments (LLM-written study notes, cached per sense).
// An enrichment belongs to the shared dictionary, not to a reader.
export * from './schema/enrichment';

// Translation runs: the provenance of every generated dictionary row. Not a
// cache and not tenant-scoped; reached through `getRawDb()` like the dictionary
// rows it accounts for.
export * from './schema/translation-runs';

// Reader votes on an enrichment and on a single translation edge, plus the
// per-headword re-enrichment cooldown. All three describe the shared
// dictionary, and all three are reached through `getRawDb()`.
export * from './schema/votes';

// The account model: `users` and `user_tokens`. A user is a person's own
// identity on this installation, reached through `getRawDb()`.
export * from './schema/users';

// The one synced document per user: the device's own store, pushed as plain
// JSON under a compare-and-swap version. Reached through `getRawDb()`.
export * from './schema/sync';

// Rate-limit counters, the daily spend cap and its operator alerts. They are
// deliberately anonymous: they protect the installation, and nothing in them
// identifies a reader. Read via `getRawDb()`.
export * from './schema/abuse';

// =============================================================================
// API Keys (Global — the bearer credential for `/api/v1/*`)
// =============================================================================
// NOT tenant-scoped, and not owned by anybody. The organizations and users this
// table used to hang off went with the ts-factory-stack scaffolding in M189:
// nothing on this installation was ever a tenant, so `organization_id` named a
// tenant that did not exist and `created_by` named an operator who had no row.
// A key is now a credential the operator mints from the CLI, and the only
// question the auth path asks of it is whether it may reach the superadmin
// endpoints. Reached through `getRawDb()`, like every other table here.

export const apiKeys = pgTable(
  'api_keys',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    prefix: text('prefix').notNull(),
    hash: text('hash').notNull(),
    /**
     * Whether this key may reach the superadmin endpoints (`/api/v1/admin/db/*`
     * and the api-key surface itself).
     *
     * IT IS A COLUMN ON THE KEY, NOT A JOIN. It used to be read off
     * `users.is_superadmin` through `api_keys.created_by`, which meant one
     * extra query on every superadmin request and a key whose authority
     * depended on a row nobody maintained. The flag belongs to the credential
     * that carries it.
     */
    isSuperadmin: boolean('is_superadmin').default(false).notNull(),
    lastUsedAt: timestamp('last_used_at'),
    expiresAt: timestamp('expires_at'),
    revoked: boolean('revoked').default(false).notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (table) => [index('api_keys_prefix_idx').on(table.prefix)],
);

export type InsertApiKey = InferInsertModel<typeof apiKeys>;
export type SelectApiKey = InferSelectModel<typeof apiKeys>;

// =============================================================================
// Data Migrations (tracks applied data migrations per environment)
// =============================================================================
// Access only via getRawDb().

export const dataMigrations = pgTable('data_migrations', {
  name: text('name').primaryKey(),
  appliedAt: timestamp('applied_at').defaultNow().notNull(),
});

export type InsertDataMigration = InferInsertModel<typeof dataMigrations>;
export type SelectDataMigration = InferSelectModel<typeof dataMigrations>;
