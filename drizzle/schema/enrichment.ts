import type { JsonValue } from '#app/lib/json';
import { relations, sql, type InferInsertModel, type InferSelectModel } from 'drizzle-orm';
import {
  pgTable,
  text,
  integer,
  numeric,
  timestamp,
  uuid,
  jsonb,
  index,
  uniqueIndex,
  check,
} from 'drizzle-orm/pg-core';
import { headwords, languages, senses } from './dictionary';

// =============================================================================
// Enrichments (Global, NOT tenant-scoped)
// =============================================================================
// One row per attempt to have a model write study notes for ONE sense, in one
// direction, under one prompt version. A successful row is the cache: the entry
// page reads it instead of calling a model again, and the workflow skips a
// sense that already has one.
//
// This table carries no `organizationId` and is deliberately absent from
// TENANT_TABLES in `drizzle/tenant-db.ts`. An enrichment is a property of the
// shared dictionary, exactly like the sense it describes, so it is reached
// through `getRawDb()`.
//
// THE CACHE KEY IS AT SENSE LEVEL, NOT HEADWORD LEVEL
//   One spelling carries several meanings. English "bank" is a river edge and a
//   place that holds money, and those are two senses of one headword. A cache
//   keyed on the headword would hold ONE set of notes for both, so whichever
//   meaning was enriched first would answer for the other one forever, and the
//   second meaning could never get notes of its own. The key is therefore the
//   sense. `headwordId` is stored beside it, denormalized on purpose, so the
//   entry page can fetch every enrichment of a headword in one indexed read
//   without joining back through `senses`.
//
// A ROW IS NEVER UPDATED
//   Every attempt is appended. A row records what one model said at one moment,
//   under one prompt, and that stays true afterwards. Re-enrichment under a new
//   `promptVersion` or a new `model` writes a new row beside the old one, and
//   both remain readable.
// =============================================================================

export const enrichments = pgTable(
  'enrichments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    senseId: uuid('sense_id')
      .notNull()
      .references(() => senses.id),
    /** Denormalized from `senses.headwordId` so the entry page reads one index, see the file comment. */
    headwordId: uuid('headword_id')
      .notNull()
      .references(() => headwords.id),
    fromLanguageCode: text('from_language_code')
      .notNull()
      .references(() => languages.code),
    toLanguageCode: text('to_language_code')
      .notNull()
      .references(() => languages.code),
    // The catalog's `ProviderId`, stored as plain text ON PURPOSE, with no
    // `$type<ProviderId>()` narrowing and no check constraint. The catalog in
    // `app/lib/llm/catalog.ts` is a live list that gains and loses entries; this
    // column is a historical record of which provider actually served a
    // request. A row written through a provider that is later removed from the
    // catalog must stay readable, and it would not be if the column's domain
    // were pinned to today's list.
    provider: text('provider').notNull(),
    model: text('model').notNull(),
    promptVersion: integer('prompt_version').notNull(),
    /** `ok` or `failed`, pinned by the check constraint below. */
    status: text('status').notNull(),
    /** The validated model output for ONE sense. Only ever set on an `ok` row. */
    output: jsonb('output').$type<JsonValue>(),
    /** The failure text. Only ever set on a `failed` row. */
    error: text('error'),
    /** Nullable: the client's pricing table does not cover every model, so the cost is sometimes unknown rather than zero. */
    costUsd: numeric('cost_usd', { precision: 10, scale: 6 }),
    latencyMs: integer('latency_ms').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    check('enrichments_status_check', sql`status in ('ok', 'failed')`),

    // THE CACHE KEY, AND WHY IT IS PARTIAL
    //
    // The uniqueness only applies to `status = 'ok'`. A failed attempt must be
    // recordable more than once: a retry after a provider outage is a NEW fact
    // about a new moment, and a full unique index would reject it, so the
    // second failure would either be lost or would have to overwrite the first.
    // A successful attempt is the opposite kind of thing. It is the permanent
    // cache entry for its key, and there may be exactly one of them, because a
    // second would make "the cached enrichment" ambiguous and would let two
    // racing workers both pay a model for the same answer.
    //
    // WHY `provider` IS NOT IN THE KEY
    //   The MODEL id is what determines the output. The same model reached
    //   through OpenRouter and reached directly is the same model answering the
    //   same prompt, so those are one cache entry, not two. Including the
    //   provider would let one model be enriched once per route into it, paying
    //   twice for the same notes. The provider is still stored, because knowing
    //   which route served a row is worth having, it just does not identify it.
    uniqueIndex('enrichments_ok_cache_key_unique')
      .on(
        table.senseId,
        table.fromLanguageCode,
        table.toLanguageCode,
        table.model,
        table.promptVersion,
      )
      .where(sql`"status" = 'ok'`),

    // The page read: every enrichment of ONE headword, for one direction, model
    // and prompt version. It starts from the headword because that is what the
    // URL carries, which is why `headwordId` is denormalized onto this table.
    index('enrichments_lookup_idx').on(
      table.headwordId,
      table.fromLanguageCode,
      table.toLanguageCode,
      table.model,
      table.promptVersion,
    ),
  ],
);

export type InsertEnrichment = InferInsertModel<typeof enrichments>;
export type SelectEnrichment = InferSelectModel<typeof enrichments>;

// Only the two `one()` edges this table owns are declared. There is
// deliberately NO language relation: two relations from one table to
// `languages` need a `relationName` on BOTH sides, and the matching `many()`
// side lives in `dictionary.ts`, which does not know this table exists. A
// half-declared pair reads as valid and fails when a query uses it, so the
// direction columns are read as plain text instead.
export const enrichmentsRelations = relations(enrichments, ({ one }) => ({
  sense: one(senses, {
    fields: [enrichments.senseId],
    references: [senses.id],
  }),
  headword: one(headwords, {
    fields: [enrichments.headwordId],
    references: [headwords.id],
  }),
}));
