/**
 * Corpus growth counts, generated versus imported, for the operator.
 *
 * NOT LICENCE-FILTERED, ON PURPOSE.
 *   Every other reader-facing query in `app/lib/dictionary/` joins `sources`
 *   and constrains `licence` in SQL (see the file comment in
 *   `app/lib/dictionary/queries.server.ts`). This module deliberately does not:
 *   it answers "what does the database hold", not "what would be served", and
 *   filtering here would hide exactly the rows an operator needs to see if a
 *   licence ever went wrong.
 *
 * THE DATABASE IS A PARAMETER, NEVER AN IMPORT, for the same reason as every
 *   other model in this directory: `drizzle/db.ts` opens a connection pool at
 *   module load, so only the type crosses this file's import boundary.
 *
 * "GENERATED" MEANS `sources.slug = 'llm-generated'`. Every content row carries
 *   a NOT NULL `sourceId` (`drizzle/schema/dictionary.ts`), so every row is
 *   either that source or an imported one; there is no third state.
 */

import { asc, desc, eq, sql } from 'drizzle-orm';
import { alias, type AnyPgColumn } from 'drizzle-orm/pg-core';

import type { DictionaryDb } from '#app/lib/dictionary/queries.server';
import { headwords, senses, sources, translations } from '#drizzle/schema';

const LLM_GENERATED_SLUG = 'llm-generated';

/** Generated and imported counts for translations between one language pair. */
export interface TranslationPairStats {
  readonly from: string;
  readonly to: string;
  readonly generated: number;
  readonly imported: number;
}

/** Generated and imported counts for senses of headwords in one language. */
export interface SenseLanguageStats {
  readonly language: string;
  readonly generated: number;
  readonly imported: number;
}

export interface CorpusStats {
  readonly translationsByPair: TranslationPairStats[];
  readonly sensesByLanguage: SenseLanguageStats[];
}

/**
 * `count(*) filter (where <sourceSlug> = 'llm-generated')`, shared by both
 * queries below.
 */
function generatedCount(sourceSlug: AnyPgColumn) {
  return sql<number>`count(*) filter (where ${sourceSlug} = ${LLM_GENERATED_SLUG})`.mapWith(Number);
}

/**
 * `count(*) filter (where <sourceSlug> <> 'llm-generated')`, the complement of
 * `generatedCount` over the same rows.
 */
function importedCount(sourceSlug: AnyPgColumn) {
  return sql<number>`count(*) filter (where ${sourceSlug} <> ${LLM_GENERATED_SLUG})`.mapWith(Number);
}

/**
 * Translations grouped by (from language, to language), split by whether the
 * edge's own source is the LLM-generated one. Ordered by total descending, so
 * the pairs the operator cares about most read first.
 *
 * TWO SENSE ALIASES, ONE ON EACH SIDE. `senses` cannot join to itself under one
 * name, and the edge's direction (`fromSenseId` to `toSenseId`) is exactly the
 * distinction the pair table exists to show.
 *
 * @param db The database handle.
 */
async function readTranslationsByPair(db: DictionaryDb): Promise<TranslationPairStats[]> {
  const fromSenses = alias(senses, 'from_senses');
  const toSenses = alias(senses, 'to_senses');
  const fromHeadwords = alias(headwords, 'from_headwords');
  const toHeadwords = alias(headwords, 'to_headwords');
  const edgeSources = alias(sources, 'edge_sources');

  const totalCount = sql<number>`count(*)`.mapWith(Number);

  return db
    .select({
      from: fromHeadwords.languageCode,
      to: toHeadwords.languageCode,
      generated: generatedCount(edgeSources.slug),
      imported: importedCount(edgeSources.slug),
    })
    .from(translations)
    .innerJoin(fromSenses, eq(translations.fromSenseId, fromSenses.id))
    .innerJoin(fromHeadwords, eq(fromSenses.headwordId, fromHeadwords.id))
    .innerJoin(toSenses, eq(translations.toSenseId, toSenses.id))
    .innerJoin(toHeadwords, eq(toSenses.headwordId, toHeadwords.id))
    .innerJoin(edgeSources, eq(translations.sourceId, edgeSources.id))
    .groupBy(fromHeadwords.languageCode, toHeadwords.languageCode)
    .orderBy(desc(totalCount));
}

/**
 * Senses grouped by their headword's language, split by whether the sense's
 * own source is the LLM-generated one. A sense has no language of its own, so
 * this is the only grain "generated senses per language" can mean.
 *
 * @param db The database handle.
 */
async function readSensesByLanguage(db: DictionaryDb): Promise<SenseLanguageStats[]> {
  const senseSources = alias(sources, 'sense_sources');

  return db
    .select({
      language: headwords.languageCode,
      generated: generatedCount(senseSources.slug),
      imported: importedCount(senseSources.slug),
    })
    .from(senses)
    .innerJoin(headwords, eq(senses.headwordId, headwords.id))
    .innerJoin(senseSources, eq(senses.sourceId, senseSources.id))
    .groupBy(headwords.languageCode)
    .orderBy(asc(headwords.languageCode));
}

/**
 * Corpus growth, generated versus imported, for `/super/llm` and for
 * `cli dictionary stats`. Both reads are plain aggregates with no per-row
 * work, so they are cheap enough for a page load and for a CLI run.
 *
 * @param db The database handle.
 */
export async function readCorpusStats(db: DictionaryDb): Promise<CorpusStats> {
  const [translationsByPair, sensesByLanguage] = await Promise.all([
    readTranslationsByPair(db),
    readSensesByLanguage(db),
  ]);

  return { translationsByPair, sensesByLanguage };
}
