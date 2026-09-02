import type { JsonValue } from '#app/lib/json';
import { type InferInsertModel, type InferSelectModel } from 'drizzle-orm';
import { pgTable, text, timestamp, uuid, jsonb, index } from 'drizzle-orm/pg-core';

// =============================================================================
// Application settings (Global, NOT tenant-scoped)
// =============================================================================
// One key-value store for operator-set configuration that must be changeable
// without a deploy. The first inhabitant is `llm.active`, the model the
// enrichment workflow runs on.
//
// WHY THESE TABLES CARRY NO `organizationId`
//   The active model is a property of the INSTALLATION, not of a tenant. One
//   worker process serves every organization from one pool of API keys, so
//   there is no coherent meaning for "org A runs Gemini while org B runs
//   Claude" until the keys are per-org too. They are therefore deliberately
//   absent from TENANT_TABLES in `drizzle/tenant-db.ts` and are read through
//   `db` directly. Adding a tenant column later is an additive migration; the
//   opposite direction, discovering the setting was global all along, is not.
//
// WHY THE VALUE IS JSONB AND NOT A COLUMN PER SETTING
//   Each setting has its own shape, and the shape is owned by the module that
//   reads it, as a Zod schema. A typed column per setting would push that
//   ownership into the schema file and make every new setting a migration. The
//   trade is that the database cannot validate the value, so every reader MUST
//   parse it and MUST survive a row it cannot parse.
//
// WHY THE AUDIT TABLE IS SEPARATE AND APPEND-ONLY
//   `app_settings` holds the current value and nothing else, so a read is a
//   single-row lookup with no ordering. The history lives beside it, one row per
//   change, written in the same transaction as the change itself. A change that
//   is not audited therefore cannot commit.
// =============================================================================

export const appSettings = pgTable('app_settings', {
  /** A dotted namespace, e.g. `llm.active`. The reading module owns the key and its value shape. */
  key: text('key').primaryKey(),
  value: jsonb('value').$type<JsonValue>().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  /** Nullable on purpose: a migration seed writes a row with no human actor behind it. */
  updatedBy: text('updated_by'),
});

export type InsertAppSetting = InferInsertModel<typeof appSettings>;
export type SelectAppSetting = InferSelectModel<typeof appSettings>;

export const appSettingsAudit = pgTable(
  'app_settings_audit',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    key: text('key').notNull(),
    /** Null for the first write of a key, where there is no previous value to record. */
    before: jsonb('before').$type<JsonValue>(),
    after: jsonb('after').$type<JsonValue>().notNull(),
    // The actor is COPIED here, it is not a foreign key, and both columns are
    // text even though `users.id` is a serial integer.
    //
    // An audit row has to outlive the account that wrote it. A foreign key would
    // either block the deletion of a user or, with ON DELETE SET NULL, quietly
    // erase who made a change the moment that person left. Neither is acceptable
    // for a history whose whole purpose is attribution, so the row keeps a
    // snapshot of the identity instead of a live reference to it.
    //
    // Text rather than integer for the same reason: the column records the
    // identity as it was presented, and it must keep working if the identity of
    // an actor ever stops being a `users.id` (an API key, a CLI operator, a
    // future SSO subject). Nothing joins on it.
    actorUserId: text('actor_user_id'),
    /** Also a snapshot. An email is what a human reading the history recognises. */
    actorEmail: text('actor_email'),
    at: timestamp('at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    // The only read this table has: the recent history of ONE key, newest first.
    // The descending `at` matches that ORDER BY so the index can be walked in
    // order and the limit stops the scan early, instead of sorting the whole
    // history of the key on every page load.
    index('app_settings_audit_key_at_idx').on(table.key, table.at.desc()),
  ],
);

export type InsertAppSettingsAuditEntry = InferInsertModel<typeof appSettingsAudit>;
export type SelectAppSettingsAuditEntry = InferSelectModel<typeof appSettingsAudit>;
