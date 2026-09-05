import { relations, sql, type InferInsertModel, type InferSelectModel } from 'drizzle-orm';
import {
  pgTable,
  text,
  integer,
  real,
  timestamp,
  uuid,
  unique,
  index,
  check,
  primaryKey,
} from 'drizzle-orm/pg-core';

// =============================================================================
// Shared Dictionary
// =============================================================================
// These tables hold the dictionary every reader shares. Access them via
// `getRawDb()`.
//
// THE DATA MODEL
//   headword  — a lemma in one language ("run", "laufen"). The word as written.
//   sense     — one meaning of a headword. An immutable identity row: it holds
//               nothing but its own id and its provenance. Every mutable
//               attribute of a sense lives in `sense_versions`.
//   translation — an edge between two senses. Meaning-to-meaning, never
//               word-to-word. This is the result surface we serve.
//   headword_link — a word-to-word edge, used only as a low-confidence
//               fallback when no sense-level path exists.
//
// THE IMMUTABLE-UUID RULE
//   Content rows are never deleted and their ids are never reused. A row that
//   should no longer be served is retired by inserting a row into
//   `entry_aliases`, which points the retired id at its replacement. Published
//   ids are therefore permanent and safe to cite from outside the database.
//
// THE LICENCE / PROVENANCE RULE
//   Every content row carries a NOT NULL `sourceId`. There is no such thing as
//   an unattributed row. `sources.licence` holds an SPDX-style identifier and
//   only allowlisted licences are ever served; the allowlist is enforced in
//   application code, at the query boundary.
// =============================================================================

// =============================================================================
// Sources (provenance and licence for every content row)
// =============================================================================

export const sources = pgTable('sources', {
  id: uuid('id').primaryKey().defaultRandom(),
  slug: text('slug').notNull().unique(),
  name: text('name').notNull(),
  url: text('url'),
  /**
   * SPDX-style identifier: `CC0-1.0`, `CC-BY-2.0-FR`, `CC-BY-4.0`. The allowlist
   * of what may be SERVED is `app/lib/dictionary/licences.ts`, not this column.
   * Our own generated content carries `CC0-1.0` like the imported data and is
   * told apart by its source slug, `llm-generated`, not by its licence.
   */
  licence: text('licence').notNull(),
  attribution: text('attribution').notNull(),
  importedAt: timestamp('imported_at', { withTimezone: true }),
  /** Upstream dump date or release tag, as the upstream publishes it. */
  version: text('version'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

export type InsertSource = InferInsertModel<typeof sources>;
export type SelectSource = InferSelectModel<typeof sources>;

export const sourcesRelations = relations(sources, ({ many }) => ({
  headwords: many(headwords),
  senses: many(senses),
  senseVersions: many(senseVersions),
  translations: many(translations),
  headwordLinks: many(headwordLinks),
  examples: many(examples),
}));

// =============================================================================
// Languages
// =============================================================================
// Seeded by the migration (`en`, `de`, `tr`, `es`), never by application code.

export const languages = pgTable('languages', {
  code: text('code').primaryKey(),
  name: text('name').notNull(),
});

export type InsertLanguage = InferInsertModel<typeof languages>;
export type SelectLanguage = InferSelectModel<typeof languages>;

export const languagesRelations = relations(languages, ({ many }) => ({
  headwords: many(headwords),
  senseVersions: many(senseVersions),
  examples: many(examples, { relationName: 'exampleLanguage' }),
  exampleTranslations: many(examples, { relationName: 'exampleTranslationLanguage' }),
}));

// =============================================================================
// Headwords (a lemma in one language)
// =============================================================================

export const headwords = pgTable(
  'headwords',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    languageCode: text('language_code')
      .notNull()
      .references(() => languages.code),
    lemma: text('lemma').notNull(),
    /** Lowercased and unaccented form of `lemma`, used for lookup. Computed in application code — deliberately not a generated column for now. */
    lemmaNormalized: text('lemma_normalized').notNull(),
    /** Part of speech, when the source records one. */
    pos: text('pos'),
    sourceId: uuid('source_id')
      .notNull()
      .references(() => sources.id),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    // The importers upsert a headword on its natural key: (language, lemma, pos).
    // `pos` is nullable, because a source that records no part of speech writes
    // NULL there. Postgres treats every NULL as distinct in a UNIQUE constraint,
    // so without NULLS NOT DISTINCT the row ('en', 'run', NULL) could be inserted
    // an unlimited number of times and no upsert could ever match an existing one.
    // Every re-run of an importer would then add a fresh duplicate, and
    // idempotency would be impossible. NULLS NOT DISTINCT makes the NULL compare
    // equal to itself, which is what the natural key means here.
    unique('headwords_language_lemma_pos_unique')
      .on(table.languageCode, table.lemma, table.pos)
      .nullsNotDistinct(),
    index('headwords_language_code_idx').on(table.languageCode),
    // The btree the importers join against. It serves EQUALITY on
    // (language_code, lemma_normalized). The GIN trigram index beside it,
    // `headwords_lemma_normalized_trgm_idx`, serves SIMILARITY for the forgiving
    // search. The two are not alternatives and neither one replaces the other.
    //
    // Its absence was invisible, because a trigram index CAN answer an equality.
    // The query worked, it returned the correct rows, and it was quietly slow.
    // Nothing failed. Measured with EXPLAIN (ANALYZE, BUFFERS) on the real
    // 383,185-row table, resolving ONE token cost a bitmap scan of 52 candidate
    // rows, 47 of which were then thrown away by the index recheck, plus 45 heap
    // blocks. The Tatoeba example attachment does that lookup for every word of
    // every sentence, millions of times per import, so this index sits on the hot
    // path of the whole import.
    //
    // Column order: `language_code` first. Both columns are equality predicates,
    // so either order answers the join, but the leading column is also useful on
    // its own for a language-scoped scan.
    //
    // That makes `headwords_language_code_idx` above redundant with this one, since
    // a composite btree already serves its leading column. It is a candidate for
    // removal, and it is deliberately left in place here: dropping an index is a
    // separate decision from adding one, and it deserves its own change.
    index('headwords_language_lemma_normalized_idx').on(table.languageCode, table.lemmaNormalized),
    index('headwords_source_id_idx').on(table.sourceId),
  ],
);

export type InsertHeadword = InferInsertModel<typeof headwords>;
export type SelectHeadword = InferSelectModel<typeof headwords>;

export const headwordsRelations = relations(headwords, ({ one, many }) => ({
  language: one(languages, {
    fields: [headwords.languageCode],
    references: [languages.code],
  }),
  source: one(sources, {
    fields: [headwords.sourceId],
    references: [sources.id],
  }),
  senses: many(senses),
  examples: many(examples),
  exampleHeadwords: many(exampleHeadwords),
  linksFrom: many(headwordLinks, { relationName: 'headwordLinkFrom' }),
  linksTo: many(headwordLinks, { relationName: 'headwordLinkTo' }),
}));

// =============================================================================
// Senses (immutable identity rows)
// =============================================================================
// Nothing mutable lives here. A sense id, once published, means the same thing
// forever; the wording of that meaning lives in `sense_versions`.

export const senses = pgTable(
  'senses',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    headwordId: uuid('headword_id')
      .notNull()
      .references(() => headwords.id),
    sourceId: uuid('source_id')
      .notNull()
      .references(() => sources.id),
    /** Upstream identifier for this sense, e.g. a Wikidata sense id such as `L123-S1`. Null for senses we mint ourselves. */
    externalId: text('external_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    // This constraint keeps its DEFAULT nulls-distinct behaviour, which is the
    // OPPOSITE choice from the headwords natural key above, for the opposite
    // reason. There, a NULL `pos` is part of the key and two rows that both omit
    // it are the same headword. Here, a NULL `external_id` means "this sense has
    // no upstream identity, we minted it ourselves", and many senses from the
    // same source will legitimately carry NULL. Under NULLS NOT DISTINCT they
    // would all collide with each other and only one could exist per source. So
    // the constraint pins down only the senses that DO carry an upstream id: one
    // sense per (source, external id), and any number of id-less senses beside
    // them. The constraint also provides the index the upsert needs, so there is
    // no separate index on `external_id`.
    unique('senses_source_external_id_unique').on(table.sourceId, table.externalId),
    index('senses_headword_id_idx').on(table.headwordId),
    index('senses_source_id_idx').on(table.sourceId),
  ],
);

export type InsertSense = InferInsertModel<typeof senses>;
export type SelectSense = InferSelectModel<typeof senses>;

export const sensesRelations = relations(senses, ({ one, many }) => ({
  headword: one(headwords, {
    fields: [senses.headwordId],
    references: [headwords.id],
  }),
  source: one(sources, {
    fields: [senses.sourceId],
    references: [sources.id],
  }),
  versions: many(senseVersions),
  examples: many(examples),
  translationsFrom: many(translations, { relationName: 'translationFromSense' }),
  translationsTo: many(translations, { relationName: 'translationToSense' }),
}));

// =============================================================================
// Sense versions (the mutable content of a sense, append-only)
// =============================================================================
// The CURRENT version of a sense is `max(version)` PER (sense, gloss language),
// derived by query. A sense holds ONE gloss per language, and each language is
// versioned independently: re-enrichment of the German gloss appends a German
// row at the next version and must not touch, hide or outrank the English one.
// So "current" is a maximum within a language, never a maximum across the
// sense, and a reader that groups by `sense_id` alone would serve whichever
// language happened to be re-enriched last.
//
// There is deliberately NO `is_current` flag: a boolean would be a second
// source of truth that can disagree with the version numbers, and keeping it
// correct needs a write to the previous row on every append.

export const senseVersions = pgTable(
  'sense_versions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    senseId: uuid('sense_id')
      .notNull()
      .references(() => senses.id),
    version: integer('version').notNull(),
    glossLanguageCode: text('gloss_language_code')
      .notNull()
      .references(() => languages.code),
    gloss: text('gloss').notNull(),
    notes: text('notes'),
    sourceId: uuid('source_id')
      .notNull()
      .references(() => sources.id),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    // The gloss language is PART of the key, not an attribute hanging off it.
    // One Wikidata sense carries glosses in several languages at once and they
    // are all the first version of that sense's text, so they all sit at
    // version 1. A two-column key on (sense_id, version) cannot hold them: the
    // second language would collide with the first, and numbering the languages
    // 1, 2, 3 would be a lie about what `version` means. Version is
    // re-enrichment order WITHIN one language.
    unique('sense_versions_sense_gloss_language_version_unique').on(
      table.senseId,
      table.glossLanguageCode,
      table.version,
    ),
    index('sense_versions_sense_id_idx').on(table.senseId),
    index('sense_versions_gloss_language_code_idx').on(table.glossLanguageCode),
    index('sense_versions_source_id_idx').on(table.sourceId),
  ],
);

export type InsertSenseVersion = InferInsertModel<typeof senseVersions>;
export type SelectSenseVersion = InferSelectModel<typeof senseVersions>;

export const senseVersionsRelations = relations(senseVersions, ({ one }) => ({
  sense: one(senses, {
    fields: [senseVersions.senseId],
    references: [senses.id],
  }),
  glossLanguage: one(languages, {
    fields: [senseVersions.glossLanguageCode],
    references: [languages.code],
  }),
  source: one(sources, {
    fields: [senseVersions.sourceId],
    references: [sources.id],
  }),
}));

// =============================================================================
// Translations (sense-to-sense edges — the result surface)
// =============================================================================

export const translations = pgTable(
  'translations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    fromSenseId: uuid('from_sense_id')
      .notNull()
      .references(() => senses.id),
    toSenseId: uuid('to_sense_id')
      .notNull()
      .references(() => senses.id),
    sourceId: uuid('source_id')
      .notNull()
      .references(() => sources.id),
    confidence: real('confidence'),
    // One short sentence saying when this word is used rather than the others,
    // written by the model that produced the edge.
    //
    // NULLABLE FOREVER, AND NOT A COLUMN TO BACKFILL. Every imported edge has
    // none and always will: an importer copies a word-to-word or sense-to-sense
    // fact out of Wikidata, PanLex or Tatoeba, and none of those sources carries
    // a usage sentence to copy. An edge generated before prompt v2 has none
    // either, because the field did not exist when it was written. So a reader
    // seeing no note is the ordinary case, not a gap waiting to be filled, and
    // no default could be honest about a word nobody wrote a note for.
    note: text('note'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    unique('translations_from_to_source_unique').on(table.fromSenseId, table.toSenseId, table.sourceId),
    check('translations_distinct_senses_check', sql`${table.fromSenseId} <> ${table.toSenseId}`),
    index('translations_from_sense_id_idx').on(table.fromSenseId),
    index('translations_to_sense_id_idx').on(table.toSenseId),
    index('translations_source_id_idx').on(table.sourceId),
  ],
);

export type InsertTranslation = InferInsertModel<typeof translations>;
export type SelectTranslation = InferSelectModel<typeof translations>;

export const translationsRelations = relations(translations, ({ one }) => ({
  fromSense: one(senses, {
    fields: [translations.fromSenseId],
    references: [senses.id],
    relationName: 'translationFromSense',
  }),
  toSense: one(senses, {
    fields: [translations.toSenseId],
    references: [senses.id],
    relationName: 'translationToSense',
  }),
  source: one(sources, {
    fields: [translations.sourceId],
    references: [sources.id],
  }),
}));

// =============================================================================
// Headword links (word-level PanLex fallback)
// =============================================================================
// A word-to-word edge with no sense resolution behind it. It is LOW CONFIDENCE
// by construction: PanLex links a spelling to a spelling, so it cannot tell
// which meaning is intended.
//
// These rows must NEVER be merged into a sense-level translation result. Serve
// them only as a clearly-labelled fallback, and only when the sense-level query
// returned nothing at all.

export const headwordLinks = pgTable(
  'headword_links',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    fromHeadwordId: uuid('from_headword_id')
      .notNull()
      .references(() => headwords.id),
    toHeadwordId: uuid('to_headword_id')
      .notNull()
      .references(() => headwords.id),
    sourceId: uuid('source_id')
      .notNull()
      .references(() => sources.id),
    kind: text('kind').notNull().default('panlex-fallback'),
    score: real('score'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    unique('headword_links_from_to_source_unique').on(table.fromHeadwordId, table.toHeadwordId, table.sourceId),
    index('headword_links_from_headword_id_idx').on(table.fromHeadwordId),
    index('headword_links_to_headword_id_idx').on(table.toHeadwordId),
    index('headword_links_source_id_idx').on(table.sourceId),
  ],
);

export type InsertHeadwordLink = InferInsertModel<typeof headwordLinks>;
export type SelectHeadwordLink = InferSelectModel<typeof headwordLinks>;

export const headwordLinksRelations = relations(headwordLinks, ({ one }) => ({
  fromHeadword: one(headwords, {
    fields: [headwordLinks.fromHeadwordId],
    references: [headwords.id],
    relationName: 'headwordLinkFrom',
  }),
  toHeadword: one(headwords, {
    fields: [headwordLinks.toHeadwordId],
    references: [headwords.id],
    relationName: 'headwordLinkTo',
  }),
  source: one(sources, {
    fields: [headwordLinks.sourceId],
    references: [sources.id],
  }),
}));

// =============================================================================
// Examples (usage sentences, attached to a sense or to a headword)
// =============================================================================

export const examples = pgTable(
  'examples',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    senseId: uuid('sense_id').references(() => senses.id),
    headwordId: uuid('headword_id').references(() => headwords.id),
    languageCode: text('language_code')
      .notNull()
      .references(() => languages.code),
    text: text('text').notNull(),
    translationText: text('translation_text'),
    translationLanguageCode: text('translation_language_code').references(() => languages.code),
    sourceId: uuid('source_id')
      .notNull()
      .references(() => sources.id),
    /** Upstream identifier, e.g. a Tatoeba sentence id. */
    externalId: text('external_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    // WHY THERE IS NO ATTACHMENT CHECK CONSTRAINT HERE
    //
    // An example is attached in one of three ways now: through `sense_id`,
    // through `headword_id`, or through one or more rows in
    // `example_headwords`. The third way is the one a Tatoeba sentence uses,
    // because one sentence mentions several headwords at once.
    //
    // A CHECK constraint can only see the row it is defined on. It cannot see
    // whether a junction row exists, because answering that needs a subquery,
    // and Postgres forbids subqueries in CHECK. A trigger can read other
    // tables, but it does not help either: the junction rows are written AFTER
    // the example row, since the junction needs the example's id. A row-level
    // trigger would therefore fire before any attachment exists and reject
    // every legal insert. A deferred constraint trigger would see the finished
    // state and would work, and it would then fire once per row on an import of
    // several million sentences.
    //
    // So attachment is enforced in two places instead. The importer never
    // writes an `examples` row it does not immediately attach, in the same
    // transaction. The query boundary only ever reaches `examples` through a
    // join from a sense or from a headword, so an unattached row is never
    // selected. An orphan example is invisible rather than illegal.
    //
    // This is a real weakening, and it should be read as one: the database will
    // now accept an `examples` row with no attachment of any kind, and nothing
    // but our own code stops it from being written.

    // The natural key an importer upserts on. Tatoeba writes `external_id` as
    // the sentence id paired with its translation id, so a re-import updates the
    // row it already wrote instead of adding a second one. Without this
    // constraint there is nothing to upsert on, and every run inserts the whole
    // corpus again.
    //
    // It stays NULLS DISTINCT deliberately, which is the OPPOSITE choice from
    // the headwords natural key above. Rows we mint ourselves, the
    // LLM-generated examples of a later milestone, carry a NULL `external_id`,
    // and there will be many of them. Under NULLS NOT DISTINCT the second such
    // row would collide with the first.
    unique('examples_source_external_id_unique').on(table.sourceId, table.externalId),
    index('examples_sense_id_idx').on(table.senseId),
    index('examples_headword_id_idx').on(table.headwordId),
    index('examples_language_code_idx').on(table.languageCode),
    index('examples_translation_language_code_idx').on(table.translationLanguageCode),
    index('examples_source_id_idx').on(table.sourceId),
  ],
);

export type InsertExample = InferInsertModel<typeof examples>;
export type SelectExample = InferSelectModel<typeof examples>;

export const examplesRelations = relations(examples, ({ one, many }) => ({
  sense: one(senses, {
    fields: [examples.senseId],
    references: [senses.id],
  }),
  headword: one(headwords, {
    fields: [examples.headwordId],
    references: [headwords.id],
  }),
  language: one(languages, {
    fields: [examples.languageCode],
    references: [languages.code],
    relationName: 'exampleLanguage',
  }),
  translationLanguage: one(languages, {
    fields: [examples.translationLanguageCode],
    references: [languages.code],
    relationName: 'exampleTranslationLanguage',
  }),
  source: one(sources, {
    fields: [examples.sourceId],
    references: [sources.id],
  }),
  exampleHeadwords: many(exampleHeadwords),
}));

// =============================================================================
// Example headwords (an example mentions many headwords)
// =============================================================================
// One sentence mentions several words. A Tatoeba sentence like "The dog runs"
// belongs to `dog` and to `run` at the same time, and the single
// `examples.headwordId` column cannot say that: it holds one id. This junction
// table is the many-to-many form of the same attachment.
//
// The composite primary key on (example_id, headword_id) is what makes the
// attachment idempotent. A second import run re-attaches the same pair, the key
// already holds that pair, and `ON CONFLICT DO NOTHING` writes zero rows. No
// bookkeeping is needed to tell a re-run from a first run.
//
// The extra index on `headword_id` is not redundant with that key. The read
// direction is "give me the examples for this headword", which starts from the
// headword; the composite key's leading column is `example_id`, so it cannot
// serve a lookup that does not know the example.

export const exampleHeadwords = pgTable(
  'example_headwords',
  {
    exampleId: uuid('example_id')
      .notNull()
      .references(() => examples.id),
    headwordId: uuid('headword_id')
      .notNull()
      .references(() => headwords.id),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.exampleId, table.headwordId], name: 'example_headwords_pkey' }),
    index('example_headwords_headword_id_idx').on(table.headwordId),
  ],
);

export type InsertExampleHeadword = InferInsertModel<typeof exampleHeadwords>;
export type SelectExampleHeadword = InferSelectModel<typeof exampleHeadwords>;

export const exampleHeadwordsRelations = relations(exampleHeadwords, ({ one }) => ({
  example: one(examples, {
    fields: [exampleHeadwords.exampleId],
    references: [examples.id],
  }),
  headword: one(headwords, {
    fields: [exampleHeadwords.headwordId],
    references: [headwords.id],
  }),
}));

// =============================================================================
// Entry aliases (retirement, in place of deletion)
// =============================================================================
// Content rows are NEVER deleted. A row that should no longer be served is
// retired by inserting an alias here, pointing its id at a replacement. Readers
// resolve a retired id through this table before serving it.
//
// `retiredId` and `replacementId` are intentionally NOT foreign keys: which
// table they point at depends on `entity`, and Postgres cannot express a
// conditional reference. The `entity` check constraint is what keeps the
// column honest.

export const entryAliases = pgTable(
  'entry_aliases',
  {
    retiredId: uuid('retired_id').primaryKey(),
    replacementId: uuid('replacement_id').notNull(),
    entity: text('entity').notNull(),
    reason: text('reason'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    check(
      'entry_aliases_entity_check',
      sql`${table.entity} IN ('headword', 'sense', 'translation')`,
    ),
  ],
);

export type InsertEntryAlias = InferInsertModel<typeof entryAliases>;
export type SelectEntryAlias = InferSelectModel<typeof entryAliases>;
