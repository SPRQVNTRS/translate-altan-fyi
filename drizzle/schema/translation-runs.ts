import type { JsonValue } from '#app/lib/json';
import { relations, sql, type InferInsertModel, type InferSelectModel } from 'drizzle-orm';
import { pgTable, text, integer, numeric, timestamp, uuid, jsonb, index, check, boolean } from 'drizzle-orm/pg-core';
import { headwords, languages } from './dictionary';

// =============================================================================
// Translation runs (provenance for the generated corpus, NOT a cache)
// =============================================================================
// One row per attempt to have a model write the senses of one headword and their
// translations into one target language. The rows it produces are ordinary
// dictionary rows in `headwords`, `senses`, `sense_versions` and `translations`,
// attributed to the generated source; THIS table records who produced them, what
// it cost, and what it wrote.
//
// WHY THIS IS NOT AN `enrichments` ROW
//   `enrichments` is a CACHE, keyed `(headword_id, from_language_code,
//   to_language_code, model, prompt_version)`, and every row read back out of it
//   is parsed with `enrichmentSenseSchema`; a row that fails that parse is
//   logged and skipped. A translation run written into that table under the same
//   model and prompt version would be picked up by the enrichment cache read,
//   fail the parse, be skipped, and leave the enrichment panel pending forever
//   for that key. Two features would share one key space and quietly break each
//   other.
//
// APPEND ONLY, AND THERE IS DELIBERATELY NO UNIQUE KEY ON THE TRIPLE
//   A run is a record of one moment. A reader retrying after a failure, a later
//   prompt version, a different model: each is a NEW fact, and a unique key on
//   `(headword_id, from_language_code, to_language_code)` would force the second
//   one to overwrite the first, destroying the record of what the first attempt
//   did. Anything asking "what is the state of this pair" reads the LATEST row
//   by `created_at`, which is what the index below serves.
//
//   The one column that is written twice is the terminal state: a row is
//   inserted `pending` at enqueue time and updated once, to `ok`, `failed` or
//   `budget`, by the job that finishes it. Nothing else on the row is ever
//   rewritten, and `retracted_at` is set at most once by the operator CLI.
//
// This table describes the shared dictionary, exactly like the rows it accounts
// for, so it is reached through `getRawDb()` and no filter narrows it to a
// reader. It holds no account id, for the reason written out in
// `app/lib/translation/job-payload.ts`.
// =============================================================================

export const translationRuns = pgTable(
  'translation_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    headwordId: uuid('headword_id')
      .notNull()
      .references(() => headwords.id),
    fromLanguageCode: text('from_language_code')
      .notNull()
      .references(() => languages.code),
    toLanguageCode: text('to_language_code')
      .notNull()
      .references(() => languages.code),
    promptVersion: integer('prompt_version').notNull(),
    // The catalog's `ProviderId`, stored as plain text ON PURPOSE, with no
    // narrowing and no check constraint, for the reason `enrichments.provider`
    // gives: the catalog is a live list, and a row written through a provider
    // that is later removed from it must stay readable.
    provider: text('provider').notNull(),
    model: text('model').notNull(),
    /** `pending`, `ok`, `failed` or `budget`, pinned by the check constraint below. */
    status: text('status').notNull().default('pending'),
    /** The validated model answer, exactly as it was parsed. Only ever set on an `ok` row. */
    output: jsonb('output').$type<JsonValue>(),
    /**
     * The ids this run created, per table: `{ headwords, senses, senseVersions, translations }`.
     *
     * THIS IS WHAT MAKES A RUN RETRACTABLE. Generated rows are permanent by
     * default and sit in the same tables as imported ones, so "undo this run"
     * has no answer unless the run says which rows were its own. Only rows the
     * run genuinely INSERTED are listed: a target headword that already existed
     * and was reused is not this run's to delete.
     */
    written: jsonb('written').$type<JsonValue>(),
    /**
     * Whether the run asked for fewer senses than the headword actually has.
     *
     * Set when the source headword carried more than `MAX_SENSES` senses, so the
     * prompt offered only the first few. It is a fact about coverage, and the
     * pane and the operator both need it: a reader looking at four of eleven
     * senses is not looking at a finished entry.
     */
    capped: boolean('capped').default(false).notNull(),
    /** The failure text. Only ever set on a `failed` or `budget` row. */
    error: text('error'),
    /** Nullable: the client's pricing table does not cover every model, so the cost is sometimes unknown rather than zero. */
    costUsd: numeric('cost_usd', { precision: 10, scale: 6 }),
    latencyMs: integer('latency_ms'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    /** When the job wrote its terminal status. Null while the run is still `pending`. */
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    /**
     * When an operator retracted this run's rows.
     *
     * The run row itself survives retraction. Deleting it would erase the record
     * that the rows ever existed, which is the one thing a retraction must not
     * do: the point is to be able to say what was published and that it was
     * taken back.
     */
    retractedAt: timestamp('retracted_at', { withTimezone: true }),
  },
  (table) => [
    check('translation_runs_status_check', sql`status in ('pending', 'ok', 'failed', 'budget')`),

    // The pane's read: the LATEST run for one headword and one direction. It is
    // the only read on the hot path, it starts from the three columns the URL
    // and the language bar supply, and it ends in `created_at desc` so the
    // newest row is the first one the index yields.
    index('translation_runs_latest_idx').on(
      table.headwordId,
      table.fromLanguageCode,
      table.toLanguageCode,
      table.createdAt.desc(),
    ),
  ],
);

export type InsertTranslationRun = InferInsertModel<typeof translationRuns>;
export type SelectTranslationRun = InferSelectModel<typeof translationRuns>;

// Only the `one()` edge to `headwords` is declared. There is deliberately NO
// language relation, for the reason `enrichmentsRelations` gives: two relations
// from one table to `languages` need a `relationName` on BOTH sides, and the
// matching `many()` side lives in `dictionary.ts`, which does not know this
// table exists. A half-declared pair reads as valid and fails when a query uses
// it, so the direction columns are read as plain text instead.
export const translationRunsRelations = relations(translationRuns, ({ one }) => ({
  headword: one(headwords, {
    fields: [translationRuns.headwordId],
    references: [headwords.id],
  }),
}));
