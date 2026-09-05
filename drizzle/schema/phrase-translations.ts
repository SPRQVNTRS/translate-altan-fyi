import { sql, type InferInsertModel, type InferSelectModel } from 'drizzle-orm';
import { pgTable, text, integer, numeric, timestamp, uuid, index, check } from 'drizzle-orm/pg-core';
import { languages } from './dictionary';

// =============================================================================
// Phrase translations (the run record AND the cache for one typed sentence)
// =============================================================================
// One row per attempt to have a model translate one piece of running text into
// one language. The row is opened `pending` by the request that queued the job
// and updated once, to `ok`, `failed` or `budget`, by the job that finishes it.
// On `ok` it also carries the answer, so the row is what a later reader is
// served: there is nowhere else for a sentence to live.
//
// 1. WHY THIS IS NOT DICTIONARY DATA, AND MUST NEVER BECOME IT
//   A sentence is not a lexical edge. The dictionary tables describe WORDS: a
//   headword is a dictionary form under `(language_code, lemma, pos)`, a sense
//   is one meaning of one such word, and an edge joins two of them. A line of
//   running text has no dictionary form and no part of speech, so writing one
//   into those tables would put a row outside the natural key every importer
//   shares. Everything M193 built then reads it: the corpus counts, the search
//   that matches a lemma, the attribution page that lists what a model wrote,
//   and the retraction path that deletes it again. Each of those would be
//   answering about a sentence while reporting about the dictionary. The
//   feature therefore ends here, in its own table, and the job that fills it in
//   writes to nothing else.
//
// 2. WHAT A ROW SAYS ABOUT A READER, WHICH IS NOTHING
//   It records the TEXT and never the person. There is no account id, no
//   session id, no device id and no address, and no log line in the phrase path
//   pairs one with the other either. That is the same line `votes.ts` holds and
//   the same line the generated dictionary rows hold: this product's claim is
//   that translating something does not build a record of who translated it,
//   and one identity column here would defeat that claim on its own, whatever
//   the rest of the app does. The text itself IS kept, because the second
//   reader of the same sentence is served this row rather than a second paid
//   call, and the privacy page says so in a sentence of its own.
//
// APPEND ONLY, AND DELIBERATELY NO UNIQUE KEY ON THE CACHE TRIPLE
//   A run is a record of one moment: a reader retrying after a failure, a later
//   prompt version and a different model are each a NEW fact. A unique key on
//   `(from, to, source_normalized)` would force the second one to overwrite the
//   first and destroy the record of what the first attempt did. Anything asking
//   "where does this sentence stand" reads the LATEST row, which is what the
//   index below serves; the cache read asks the same index for the latest `ok`
//   row.
//
// This table describes no reader, so it is reached through `getRawDb()` and no
// filter narrows it to one.
// =============================================================================

export const phraseTranslations = pgTable(
  'phrase_translations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    fromLanguageCode: text('from_language_code')
      .notNull()
      .references(() => languages.code),
    toLanguageCode: text('to_language_code')
      .notNull()
      .references(() => languages.code),
    /** The text as the reader typed it, whitespace-trimmed and nothing else. It is what the model is shown. */
    sourceText: text('source_text').notNull(),
    /**
     * The cache key: `normalizeQuery(sourceText, from).normalized`.
     *
     * IT IS STORED RATHER THAN COMPUTED ON READ, because the read is an index
     * lookup on three columns and a function call in the WHERE clause would
     * make it a scan. The folding is the same one the word path keys on, so
     * `Das Auto volltanken` and `das auto  volltanken` are one cache entry and
     * the second reader pays nothing.
     */
    sourceNormalized: text('source_normalized').notNull(),
    /** `pending`, `ok`, `failed` or `budget`, pinned by the check constraint below. */
    status: text('status').notNull().default('pending'),
    /**
     * The answer, in the target language. Only ever set on an `ok` row.
     *
     * ONE SENTENCE AND NOTHING ELSE. No notes, no alternatives, no explanation:
     * the schema the model answers under carries a single string, so there is
     * no second field here for anything to accumulate in.
     */
    translationText: text('translation_text'),
    // Plain text with no narrowing and no check constraint, for the reason
    // `translation_runs.provider` gives: the catalog is a live list, and a row
    // written through a provider that is later removed from it must stay
    // readable.
    provider: text('provider').notNull(),
    model: text('model').notNull(),
    promptVersion: integer('prompt_version').notNull(),
    /** Nullable: the pricing table does not cover every model, so a cost is sometimes unknown rather than zero. */
    costUsd: numeric('cost_usd', { precision: 10, scale: 6 }),
    latencyMs: integer('latency_ms'),
    /** The failure text. Only ever set on a `failed` or `budget` row. */
    error: text('error'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    /** When the job wrote its terminal status. Null while the row is still `pending`. */
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (table) => [
    check('phrase_translations_status_check', sql`status in ('pending', 'ok', 'failed', 'budget')`),

    // The pane's one read: the latest row for one direction and one folded
    // sentence. It starts from the three columns the search box and the
    // language bar supply, and it ends in `created_at desc` so the newest row
    // is the first one the index yields. The cache read adds a status test on
    // top of the same three columns.
    index('phrase_translations_latest_idx').on(
      table.fromLanguageCode,
      table.toLanguageCode,
      table.sourceNormalized,
      table.createdAt.desc(),
    ),
  ],
);

export type InsertPhraseTranslation = InferInsertModel<typeof phraseTranslations>;
export type SelectPhraseTranslation = InferSelectModel<typeof phraseTranslations>;

// No relations are declared. The only edges this table has are the two language
// columns, and two relations from one table to `languages` need a
// `relationName` on BOTH sides, with the matching `many()` side living in
// `dictionary.ts`, which does not know this table exists. A half-declared pair
// reads as valid and fails when a query uses it, so the direction columns are
// read as plain text instead, exactly as `translation_runs` reads its own.
