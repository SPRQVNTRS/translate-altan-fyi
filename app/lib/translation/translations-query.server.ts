/**
 * Every translation of one headword into one language, whoever wrote it.
 *
 * WHY IT IS NOT `entryTranslationsQuery`.
 *   That query takes SENSE ids, because the entry page renders its edges under
 *   the sense they belong to. This one takes a HEADWORD, because the search
 *   pane asks a different question: "does this word have an answer in the target
 *   language at all". A headword with six senses and one translated sense has an
 *   answer; a headword with no sense at all has none, and that second case is
 *   the whole reason M193 exists. Passing sense ids here would reproduce the
 *   zero-sense short circuit this milestone was written to remove.
 *
 * WHY IT IS ITS OWN MODULE RATHER THAN A FUNCTION INSIDE `panel.server.ts`.
 *   The panel's gate is decided by four reads, and a unit test has to be able to
 *   fake each of them. Three of the four already live behind their own module
 *   (`rate-limit.server`, `budget.server`, `translation-runs.server`), and this
 *   file is the fourth, so `tests/unit/translation-panel-gate.test.ts` can stub
 *   the corpus read the same way it stubs the others instead of hand-building a
 *   Drizzle query chain.
 *
 * THE DATABASE IS A PARAMETER, NEVER AN IMPORT. `drizzle/db.ts` opens a pool at
 * module load; the same rule the dictionary queries follow.
 *
 * THE LICENCE FILTER IS IN THE SQL, ON BOTH SIDES. The edge's own source and the
 * source that supplied the target lemma are both content that reaches a reader,
 * so both are filtered in the statement rather than in a `.filter()` over rows
 * that have already been fetched.
 */

import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';

import type { LanguageCode } from '#app/lib/dictionary/detect-language';
import { GENERATED_SOURCE_SLUG } from '#app/lib/dictionary/generated-source';
import { SERVED_LICENCES } from '#app/lib/dictionary/licences';
import type { DictionaryDb } from '#app/lib/dictionary/queries.server';
import { headwords, senses, sources, translations } from '#drizzle/schema';

/** One translation as the search pane renders it. */
export interface TranslationRow {
  /** The target-language word itself. */
  lemma: string;
  /** Its part of speech, or `null` when the target headword carries none. */
  pos: string | null;
  /** The edge's own confidence, 0 to 1, or `null` for an imported edge that states none. */
  confidence: number | null;
  /**
   * Whether a language model wrote this edge.
   *
   * It is the SOURCE SLUG that decides, never the licence: decision 12 moved the
   * generated source's licence to `CC0-1.0`, which is exactly the licence three
   * imports also carry, so a licence test would mark Wikidata rows as generated
   * from the day that migration ran.
   */
  generated: boolean;
}

export interface TranslationsIntoParams {
  headwordId: string;
  to: LanguageCode;
}

/**
 * Every distinct translation of `headwordId` into `to`.
 *
 * Deduplicated on the written word and its part of speech, because two sources
 * asserting the same word is a fact about the dictionary rather than about the
 * word. An imported row wins over a generated one for the same word: the rows
 * are ordered so that a generated duplicate is dropped rather than the imported
 * one, and a reader is not shown a "Generated" marker on a word an import
 * already carried.
 *
 * @param db The database handle.
 * @param params The headword and the language to translate into.
 * @returns The rows, alphabetical by word. Empty means this pair has no answer yet.
 */
export async function listTranslationsInto(
  db: DictionaryDb,
  params: TranslationsIntoParams,
): Promise<TranslationRow[]> {
  const targetSenses = alias(senses, 'target_senses');
  const targetHeadwords = alias(headwords, 'target_headwords');
  const targetSources = alias(sources, 'target_sources');

  const rows = await db
    .select({
      lemma: targetHeadwords.lemma,
      pos: targetHeadwords.pos,
      confidence: translations.confidence,
      sourceSlug: sources.slug,
    })
    .from(translations)
    .innerJoin(senses, eq(translations.fromSenseId, senses.id))
    .innerJoin(targetSenses, eq(translations.toSenseId, targetSenses.id))
    .innerJoin(targetHeadwords, eq(targetSenses.headwordId, targetHeadwords.id))
    .innerJoin(targetSources, eq(targetHeadwords.sourceId, targetSources.id))
    .innerJoin(sources, eq(translations.sourceId, sources.id))
    .where(
      and(
        eq(senses.headwordId, params.headwordId),
        eq(targetHeadwords.languageCode, params.to),
        inArray(sources.licence, [...SERVED_LICENCES]),
        inArray(targetSources.licence, [...SERVED_LICENCES]),
      ),
    )
    // The generated flag leads the tie break, and it is written as SQL rather
    // than as a slug sort: `llm-generated` sorts BEFORE `tatoeba-cc0` and
    // `wikidata-lexemes` alphabetically, so ordering by the slug would hand
    // every duplicate to the model. `false` sorts before `true` in Postgres, so
    // an imported row reaches the dedupe first and the generated copy is the one
    // that is dropped.
    .orderBy(asc(targetHeadwords.lemma), asc(sql`${sources.slug} = ${GENERATED_SOURCE_SLUG}`), asc(sources.slug));

  const seen = new Set<string>();
  const deduplicated: TranslationRow[] = [];
  for (const row of rows) {
    const key = `${row.lemma}:${row.pos ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduplicated.push({
      lemma: row.lemma,
      pos: row.pos,
      confidence: row.confidence,
      generated: row.sourceSlug === GENERATED_SOURCE_SLUG,
    });
  }
  return deduplicated;
}
