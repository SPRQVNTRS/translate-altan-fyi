/**
 * Forgiving headword search: the read path behind the search box.
 *
 * THE TWO RULES OF `queries.server.ts` APPLY HERE UNCHANGED.
 *   1. THE DATABASE IS A PARAMETER, NEVER AN IMPORT. `drizzle/db.ts` opens a
 *      pool at module load, so importing it here would open one in every
 *      process that touches this module, the unit tests included. The handle
 *      arrives as the first argument and only its TYPE is imported.
 *   2. THE LICENCE FILTER LIVES IN THE SQL. Every statement below joins
 *      `sources` and constrains `sources.licence` inside the query. A
 *      `.filter()` over the returned rows is invisible to `toSQL()` and absent
 *      from any code path that forgets to call it.
 *
 * EXACT BEFORE FUZZY, ALWAYS.
 *   A reader who typed the word correctly must see that word first. So the two
 *   branches are two statements rather than one ranked query: an `order by
 *   similarity desc` puts an exact match first only because its similarity
 *   happens to be 1, which is a property of the scoring function rather than a
 *   guarantee of the query. Two branches make the ordering structural.
 *
 * THE PER-HIT DATA IS BATCHED, NEVER PER HIT.
 *   Gloss, translations and examples are three relations hanging off up to
 *   `limit` headwords. Fetching them inside a loop would be four round trips
 *   per hit on the hot path of every search, and the count would grow with the
 *   result set. Instead the hit ids are gathered first and each relation is one
 *   `inArray` statement over all of them, so the statement count is a constant
 *   no matter how many hits came back.
 */

import { and, asc, desc, eq, inArray, notInArray, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import {
  exampleHeadwords,
  examples,
  headwords,
  senseVersions,
  senses,
  sources,
  translations,
} from '#drizzle/schema';
import type { LanguageCode } from './detect-language';
import { SERVED_LICENCES } from './licences';
import { normalizeForLanguage } from './normalize';
import { currentSenseVersions, currentVersionColumn, type DictionaryDb } from './queries.server';

/** Trigram similarity a fuzzy match must clear. Named, never inlined in a query. */
export const SIMILARITY_THRESHOLD = 0.35;

/** How many headwords a search returns when the caller states no limit. */
const DEFAULT_SEARCH_LIMIT = 20;

/** How many examples travel with one search hit. The entry page shows more. */
const EXAMPLES_PER_HIT = 2;

/**
 * The licence predicate, as SQL.
 *
 * `queries.server.ts` keeps its own copy private, so this is the local
 * equivalent rather than a shared import. Spread into a mutable array because
 * `SERVED_LICENCES` is a readonly tuple and `inArray` takes a plain array; the
 * values land in the statement as bound parameters, which is what the SQL-level
 * test asserts on.
 */
function servedLicence() {
  return inArray(sources.licence, [...SERVED_LICENCES]);
}

/**
 * Target-language preference, as SQL.
 *
 * WHY THE PREFERENCE IS IN THE STATEMENT AND NOT ONLY IN JAVASCRIPT
 *   The example queries are capped, on the entry page by `.limit()` and on both
 *   surfaces by the per-headword cap. A cap applied to rows ordered by id alone
 *   spends its whole budget on whatever sentences happen to sort first, so a
 *   reader asking for English can be served five Spanish translations while the
 *   English ones sit two rows further down and are never fetched. Ordering the
 *   preferred rows first means the budget reaches them.
 *
 *   The JavaScript selection in `collectExamples` is the second half, not a
 *   duplicate: SQL decides which rows are FETCHED, and the selection decides
 *   which of the fetched rows are SHOWN. Neither half does the other's job.
 */
export function preferTargetLanguage(to: LanguageCode) {
  return sql`case when ${examples.translationLanguageCode} = ${to} then 0 else 1 end`;
}

// =============================================================================
// The result shape
// =============================================================================

/** One translation of a hit into the target language, with the source that asserted it. */
export interface SearchHitTranslation {
  headwordId: string;
  lemma: string;
  languageCode: string;
  sourceSlug: string;
  /** The source's own name, for the compact "<name>, <licence>" credit. */
  sourceName: string;
  /** The raw licence identifier. `licenceLabel` turns it into display text. */
  sourceLicence: string;
}

/** One usage sentence shown under a hit. */
export interface SearchHitExample {
  id: string;
  text: string;
  languageCode: string;
  translationText: string | null;
  translationLanguageCode: string | null;
  /** The upstream identifier, which `sourceRecordUrl` turns into a deep link. */
  externalId: string | null;
  sourceSlug: string;
  sourceName: string;
  sourceLicence: string;
}

/** One headword the query matched, with everything the result card renders. */
export interface SearchHit {
  headwordId: string;
  lemma: string;
  pos: string | null;
  languageCode: string;
  matchKind: 'exact' | 'fuzzy';
  similarity: number;
  /** The current gloss of this headword in the TARGET language, when one exists. */
  gloss: string | null;
  translations: SearchHitTranslation[];
  examples: SearchHitExample[];
}

export interface SearchHeadwordsParams {
  q: string;
  from: LanguageCode;
  to: LanguageCode;
  limit?: number;
}

// =============================================================================
// The two branch builders
// =============================================================================

/** What both branch builders need. */
export interface BranchParams {
  /** The query, already through `normalizeForLanguage`. */
  normalizedQuery: string;
  /** The language being searched. Always constrained: a search is directional. */
  from: LanguageCode;
  limit: number;
}

/** `BranchParams` plus the ids the exact branch already served. */
export interface FuzzyBranchParams extends BranchParams {
  excludeIds: string[];
}

/**
 * Exact matches on `lemma_normalized`, licence-filtered in SQL.
 *
 * Returned un-awaited, so `tests/unit/dictionary-search.test.ts` can read the
 * generated statement and a caller can simply await it. The equality is served
 * by `headwords_language_lemma_normalized_idx`.
 */
export function exactHeadwordsQuery(db: DictionaryDb, params: BranchParams) {
  return db
    .select({
      headwordId: headwords.id,
      lemma: headwords.lemma,
      pos: headwords.pos,
      languageCode: headwords.languageCode,
    })
    .from(headwords)
    .innerJoin(sources, eq(headwords.sourceId, sources.id))
    .where(
      and(
        eq(headwords.lemmaNormalized, params.normalizedQuery),
        eq(headwords.languageCode, params.from),
        servedLicence(),
      ),
    )
    .orderBy(asc(headwords.lemma))
    .limit(params.limit);
}

/**
 * Fuzzy matches on `lemma_normalized`, licence-filtered in SQL.
 *
 * WHY THE PREDICATE IS WRITTEN TWICE.
 *   `lemma_normalized % $q` is the operator that
 *   `headwords_lemma_normalized_trgm_idx` answers, and it is the only reason
 *   this is an index scan. On its own,
 *   `similarity(lemma_normalized, $q) > 0.35` is a function call over a column,
 *   which no index can satisfy, so Postgres would read the whole table for
 *   every keystroke.
 *
 *   The two do not mean the same thing. `%` compares against the session GUC
 *   `pg_trgm.similarity_threshold`, whose default is 0.3, which is a WIDER net
 *   than the 0.35 this product wants. So the operator selects candidate rows
 *   cheaply and the explicit comparison is what DECIDES the result set. Neither
 *   half is redundant: drop the operator and the query is a sequential scan,
 *   drop the comparison and the threshold silently becomes whatever the session
 *   GUC happens to hold, a value this code neither sets nor can see.
 *
 * `excludeIds` carries the ids the exact branch already returned, and is
 * applied only when non-empty, because `not in ()` is not valid SQL.
 */
export function fuzzyHeadwordsQuery(db: DictionaryDb, params: FuzzyBranchParams) {
  const score = sql<number>`similarity(${headwords.lemmaNormalized}, ${params.normalizedQuery})`;
  return db
    .select({
      headwordId: headwords.id,
      lemma: headwords.lemma,
      pos: headwords.pos,
      languageCode: headwords.languageCode,
      similarity: score,
    })
    .from(headwords)
    .innerJoin(sources, eq(headwords.sourceId, sources.id))
    .where(
      and(
        sql`${headwords.lemmaNormalized} % ${params.normalizedQuery}`,
        sql`${score} > ${SIMILARITY_THRESHOLD}`,
        eq(headwords.languageCode, params.from),
        servedLicence(),
        params.excludeIds.length > 0 ? notInArray(headwords.id, params.excludeIds) : undefined,
      ),
    )
    .orderBy(desc(score), asc(headwords.lemma))
    .limit(params.limit);
}

// =============================================================================
// The batched relation queries
// =============================================================================

/**
 * The current gloss of each headword in one language, licence-filtered in SQL.
 *
 * "Current" is `max(version)` per (sense, gloss language), which is what
 * `currentSenseVersions` computes. Joining on BOTH columns is mandatory:
 * matching on `sense_id` alone would keep one gloss per sense in whichever
 * language happened to sit at the highest version number, which is a language
 * picked at random per sense.
 *
 * The version leg of the join uses `currentVersionColumn`, the qualified SQL
 * reference, rather than the aggregate read off the subquery handle. Drizzle
 * renders the handle form as a bare name, which Postgres cannot resolve here.
 *
 * Ordered by `senses.id` so a headword with several senses always yields the
 * same gloss between two identical requests. Row order is not an ordering.
 */
export function glossesForHeadwordsQuery(
  db: DictionaryDb,
  params: { headwordIds: string[]; glossLanguage: LanguageCode },
) {
  const current = currentSenseVersions(db);
  return db
    .select({
      headwordId: senses.headwordId,
      senseId: senses.id,
      gloss: senseVersions.gloss,
      glossLanguageCode: senseVersions.glossLanguageCode,
      sourceSlug: sources.slug,
      sourceName: sources.name,
      sourceLicence: sources.licence,
    })
    .from(senseVersions)
    .innerJoin(
      current,
      and(
        eq(current.senseId, senseVersions.senseId),
        eq(current.glossLanguageCode, senseVersions.glossLanguageCode),
        eq(currentVersionColumn, senseVersions.version),
      ),
    )
    .innerJoin(senses, eq(senses.id, senseVersions.senseId))
    .innerJoin(sources, eq(senseVersions.sourceId, sources.id))
    .where(
      and(
        inArray(senses.headwordId, params.headwordIds),
        eq(senseVersions.glossLanguageCode, params.glossLanguage),
        servedLicence(),
      ),
    )
    .orderBy(asc(senses.id));
}

/**
 * Sense-level translations of each headword into one language, licence-filtered
 * in SQL, on BOTH sides.
 *
 * TWO SOURCES ARE FILTERED, NOT ONE. `sources` here is the source that ASSERTED
 * the edge, and `target_sources` is the source that supplied the target lemma.
 * That lemma is content which reaches the page, so filtering only the edge's
 * source would publish a share-alike word through an open-licensed edge.
 *
 * Edges are stored in both directions, so following `from_sense_id` alone
 * reaches every partner and no union is needed.
 */
export function translationsForHeadwordsQuery(
  db: DictionaryDb,
  params: { headwordIds: string[]; to: LanguageCode },
) {
  const targetSenses = alias(senses, 'target_senses');
  const targetHeadwords = alias(headwords, 'target_headwords');
  const targetSources = alias(sources, 'target_sources');
  return db
    .select({
      fromHeadwordId: senses.headwordId,
      headwordId: targetHeadwords.id,
      lemma: targetHeadwords.lemma,
      languageCode: targetHeadwords.languageCode,
      sourceSlug: sources.slug,
      sourceName: sources.name,
      sourceLicence: sources.licence,
    })
    .from(translations)
    .innerJoin(senses, eq(translations.fromSenseId, senses.id))
    .innerJoin(targetSenses, eq(translations.toSenseId, targetSenses.id))
    .innerJoin(targetHeadwords, eq(targetSenses.headwordId, targetHeadwords.id))
    .innerJoin(targetSources, eq(targetHeadwords.sourceId, targetSources.id))
    .innerJoin(sources, eq(translations.sourceId, sources.id))
    .where(
      and(
        inArray(senses.headwordId, params.headwordIds),
        eq(targetHeadwords.languageCode, params.to),
        servedLicence(),
        inArray(targetSources.licence, [...SERVED_LICENCES]),
      ),
    )
    .orderBy(asc(targetHeadwords.lemma));
}

/**
 * Examples attached through the `example_headwords` junction, licence-filtered
 * in SQL.
 *
 * This is how Tatoeba attaches, and it is the common case: one sentence
 * mentions several words at once, which the single `examples.headword_id`
 * column cannot express.
 */
export function junctionExamplesQuery(
  db: DictionaryDb,
  params: { headwordIds: string[]; to: LanguageCode },
) {
  return db
    .select({
      headwordId: exampleHeadwords.headwordId,
      id: examples.id,
      text: examples.text,
      languageCode: examples.languageCode,
      translationText: examples.translationText,
      translationLanguageCode: examples.translationLanguageCode,
      externalId: examples.externalId,
      sourceSlug: sources.slug,
      sourceName: sources.name,
      sourceLicence: sources.licence,
    })
    .from(exampleHeadwords)
    .innerJoin(examples, eq(exampleHeadwords.exampleId, examples.id))
    .innerJoin(sources, eq(examples.sourceId, sources.id))
    .where(and(inArray(exampleHeadwords.headwordId, params.headwordIds), servedLicence()))
    // Preference first, id second. The id leg is what keeps two identical
    // requests in the same order; on its own it decides which language wins.
    .orderBy(preferTargetLanguage(params.to), asc(examples.id));
}

/** Examples attached directly through `examples.headword_id`, licence-filtered in SQL. */
export function directExamplesQuery(
  db: DictionaryDb,
  params: { headwordIds: string[]; to: LanguageCode },
) {
  return db
    .select({
      headwordId: examples.headwordId,
      id: examples.id,
      text: examples.text,
      languageCode: examples.languageCode,
      translationText: examples.translationText,
      translationLanguageCode: examples.translationLanguageCode,
      externalId: examples.externalId,
      sourceSlug: sources.slug,
      sourceName: sources.name,
      sourceLicence: sources.licence,
    })
    .from(examples)
    .innerJoin(sources, eq(examples.sourceId, sources.id))
    .where(and(inArray(examples.headwordId, params.headwordIds), servedLicence()))
    .orderBy(preferTargetLanguage(params.to), asc(examples.id));
}

// =============================================================================
// Assembly
// =============================================================================

/** A row of either example query, before it is grouped by headword. */
export interface ExampleRow {
  headwordId: string | null;
  id: string;
  text: string;
  languageCode: string;
  translationText: string | null;
  translationLanguageCode: string | null;
  externalId: string | null;
  sourceSlug: string;
  sourceName: string;
  sourceLicence: string;
}

/** A row of `translationsForHeadwordsQuery`, before it is grouped by headword. */
export interface TranslationRow {
  fromHeadwordId: string;
  headwordId: string;
  lemma: string;
  languageCode: string;
  sourceSlug: string;
  sourceName: string;
  sourceLicence: string;
}

/** A matched headword, before its relations are attached. */
interface MatchedHeadword {
  headwordId: string;
  lemma: string;
  pos: string | null;
  languageCode: string;
  matchKind: 'exact' | 'fuzzy';
  similarity: number;
}

/**
 * Group translations under the headword they belong to, de-duplicated by lemma.
 *
 * The lemma is the de-duplication key rather than the target headword id,
 * because the same word imported by two sources is two rows and one word to a
 * reader, and a result card that lists it twice reads as a bug.
 */
export function collectTranslations(rows: TranslationRow[]): Map<string, SearchHitTranslation[]> {
  const byHeadword = new Map<string, SearchHitTranslation[]>();
  const seen = new Set<string>();
  for (const row of rows) {
    const key = `${row.fromHeadwordId} ${row.lemma}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const bucket = byHeadword.get(row.fromHeadwordId) ?? [];
    bucket.push({
      headwordId: row.headwordId,
      lemma: row.lemma,
      languageCode: row.languageCode,
      sourceSlug: row.sourceSlug,
      sourceName: row.sourceName,
      sourceLicence: row.sourceLicence,
    });
    byHeadword.set(row.fromHeadwordId, bucket);
  }
  return byHeadword;
}

/**
 * Group examples under the headword they belong to, preferring the target
 * language, capped per headword.
 *
 * THE THREE STEPS ARE IN THIS ORDER FOR A REASON.
 *   1. De-duplicate. The two example queries can return the same sentence for
 *      the same headword, once through the junction and once through
 *      `examples.headword_id`.
 *   2. Choose the language. A sentence whose translation is in the language the
 *      reader asked for is the answer; a translation into some third language
 *      is not, and it is what put a Spanish sentence under an English lookup.
 *   3. Cap. The cap is applied LAST. Capping while the bucket fills, which is
 *      what this function used to do, drops a preferred row that happens to
 *      sort after `cap` other rows, and the preference then never sees it.
 *
 * THE CHOICE IS PER HEADWORD, NOT ACROSS THE RESULT SET.
 *   A search returns many headwords and the corpus covers them unevenly: one
 *   word may have ten English-translated sentences and the next word none at
 *   all. A global rule would either strip every example from the second word or
 *   admit off-language rows for the first. Deciding per headword gives each
 *   word the best it has, and only falls back where that word has nothing
 *   better.
 *
 * @param rows The de-duplicated union of both example queries.
 * @param cap How many sentences one headword may show.
 * @param to The language the reader is translating into.
 */
export function collectExamples(
  rows: ExampleRow[],
  cap: number,
  to: LanguageCode,
): Map<string, SearchHitExample[]> {
  const byHeadword = new Map<string, SearchHitExample[]>();
  const seen = new Set<string>();
  for (const row of rows) {
    const headwordId = row.headwordId;
    if (headwordId === null) continue;
    const key = `${headwordId} ${row.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const bucket = byHeadword.get(headwordId) ?? [];
    bucket.push({
      id: row.id,
      text: row.text,
      languageCode: row.languageCode,
      translationText: row.translationText,
      translationLanguageCode: row.translationLanguageCode,
      externalId: row.externalId,
      sourceSlug: row.sourceSlug,
      sourceName: row.sourceName,
      sourceLicence: row.sourceLicence,
    });
    byHeadword.set(headwordId, bucket);
  }
  const chosen = new Map<string, SearchHitExample[]>();
  for (const [headwordId, bucket] of byHeadword) {
    const preferred = bucket.filter((example) => example.translationLanguageCode === to);
    // An empty `preferred` is the fallback case: this headword has nothing in
    // the target language, and one off-language sentence beats none at all.
    const kept = preferred.length > 0 ? preferred : bucket;
    chosen.set(headwordId, kept.slice(0, cap));
  }
  return chosen;
}

/**
 * Search headwords in one language, with everything a result card renders.
 *
 * @param db The dictionary database handle.
 * @param params The raw query text and the direction the lookup runs in.
 * @returns Exact hits first, then fuzzy hits by descending similarity.
 */
export async function searchHeadwords(
  db: DictionaryDb,
  params: SearchHeadwordsParams,
): Promise<SearchHit[]> {
  // The normalization goes through `normalizeForLanguage`, not `normalizeLemma`.
  // That call IS the locale seam: v1 ignores the language, and the day Turkish
  // casing lands, this call site is already passing the language it needs.
  const normalizedQuery = normalizeForLanguage(params.q, params.from);
  // An empty query touches no database at all. It has no answer, and asking
  // Postgres for the answer to nothing still costs a round trip per request.
  if (normalizedQuery === '') return [];
  const limit = params.limit ?? DEFAULT_SEARCH_LIMIT;
  if (limit <= 0) return [];
  const exactRows = await exactHeadwordsQuery(db, {
    normalizedQuery,
    from: params.from,
    limit,
  });
  const matches: MatchedHeadword[] = exactRows.map((row) => ({
    headwordId: row.headwordId,
    lemma: row.lemma,
    pos: row.pos,
    languageCode: row.languageCode,
    matchKind: 'exact',
    // An exact match is not scored. It is 1 by definition of the branch it came
    // from, never by asking pg_trgm what it thinks of a string against itself.
    similarity: 1,
  }));
  const remaining = limit - matches.length;
  // The fuzzy branch is skipped entirely once the exact branch filled the page.
  if (remaining > 0) {
    const fuzzyRows = await fuzzyHeadwordsQuery(db, {
      normalizedQuery,
      from: params.from,
      limit: remaining,
      excludeIds: matches.map((match) => match.headwordId),
    });
    for (const row of fuzzyRows) {
      matches.push({
        headwordId: row.headwordId,
        lemma: row.lemma,
        pos: row.pos,
        languageCode: row.languageCode,
        matchKind: 'fuzzy',
        similarity: Number(row.similarity),
      });
    }
  }
  if (matches.length === 0) return [];
  const headwordIds = matches.map((match) => match.headwordId);
  const [glossRows, translationRows, junctionRows, directRows] = await Promise.all([
    glossesForHeadwordsQuery(db, { headwordIds, glossLanguage: params.to }),
    translationsForHeadwordsQuery(db, { headwordIds, to: params.to }),
    junctionExamplesQuery(db, { headwordIds, to: params.to }),
    directExamplesQuery(db, { headwordIds, to: params.to }),
  ]);
  // First row wins, and the query ordered by `senses.id`, so the chosen gloss
  // is the same on every request rather than whichever row Postgres returned
  // first this time.
  const glossByHeadword = new Map<string, string>();
  for (const row of glossRows) {
    if (glossByHeadword.has(row.headwordId)) continue;
    glossByHeadword.set(row.headwordId, row.gloss);
  }
  const translationsByHeadword = collectTranslations(translationRows);
  const examplesByHeadword = collectExamples(
    [...junctionRows, ...directRows],
    EXAMPLES_PER_HIT,
    params.to,
  );
  return matches.map((match) => ({
    headwordId: match.headwordId,
    lemma: match.lemma,
    pos: match.pos,
    languageCode: match.languageCode,
    matchKind: match.matchKind,
    similarity: match.similarity,
    gloss: glossByHeadword.get(match.headwordId) ?? null,
    translations: translationsByHeadword.get(match.headwordId) ?? [],
    examples: examplesByHeadword.get(match.headwordId) ?? [],
  }));
}
