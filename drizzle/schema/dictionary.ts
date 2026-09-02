import { relations, sql, type InferInsertModel, type InferSelectModel } from 'drizzle-orm';
import { pgTable, text, integer, real, timestamp, uuid, unique, index, check } from 'drizzle-orm/pg-core';

// =============================================================================
// Shared Dictionary (Global — NOT tenant-scoped)
// =============================================================================
// These tables hold the shared, cross-organization dictionary. They carry no
// `organizationId` column and are deliberately NOT listed in TENANT_TABLES in
// `drizzle/tenant-db.ts`. Access them via `getRawDb()`.
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
  /** SPDX-style identifier: `CC0-1.0`, `CC-BY-2.0-FR`, `CC-BY-4.0`, plus `LLM-GENERATED` for our own enrichment output. */
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
    unique('headwords_language_lemma_pos_unique').on(table.languageCode, table.lemma, table.pos),
    index('headwords_language_code_idx').on(table.languageCode),
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
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
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
// The CURRENT version of a sense is `max(version)` for that `senseId`, derived
// by query. There is deliberately NO `is_current` flag: a boolean would be a
// second source of truth that can disagree with the version numbers, and
// keeping it correct needs a write to the previous row on every append.

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
    unique('sense_versions_sense_version_unique').on(table.senseId, table.version),
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
    check(
      'examples_attachment_check',
      sql`${table.senseId} IS NOT NULL OR ${table.headwordId} IS NOT NULL`,
    ),
    index('examples_sense_id_idx').on(table.senseId),
    index('examples_headword_id_idx').on(table.headwordId),
    index('examples_language_code_idx').on(table.languageCode),
    index('examples_translation_language_code_idx').on(table.translationLanguageCode),
    index('examples_source_id_idx').on(table.sourceId),
  ],
);

export type InsertExample = InferInsertModel<typeof examples>;
export type SelectExample = InferSelectModel<typeof examples>;

export const examplesRelations = relations(examples, ({ one }) => ({
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
