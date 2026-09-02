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
import { normalizeQuery, normalizeSentence } from './normalize';
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
  /** The query, already through `normalizeQuery`. */
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
  // The normalization goes through `normalizeQuery`, which wraps
  // `normalizeForLanguage`, not `normalizeLemma`. That call IS the locale seam,
  // and it is load-bearing: `params.from` selects the Turkish rules that fold
  // all four i letters onto `i`, and the German rule that folds `ß` to `ss`.
  // The SAME function wrote `headwords.lemma_normalized` on import, which is
  // the only reason the `=` below can match anything. What `normalizeQuery`
  // adds on top is query-side only: the quotes and the trailing question mark a
  // reader types, which a stored lemma never carries.
  const normalizedQuery = normalizeQuery(params.q, params.from).normalized;
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

// =============================================================================
// The phrase branch
// =============================================================================
//
// A PHRASE IS NOT A LONGER WORD, AND THE SINGLE-WORD PATH CANNOT SERVE IT.
//   `headwords.lemma_normalized` holds words. A reader who types "guten Tag"
//   has typed something that is in no headword column at all, so the exact
//   branch finds nothing and the trigram branch returns whichever single word
//   happens to share the most three-letter runs with the whole string, which is
//   a coincidence rather than an answer.
//
//   So a phrase is answered by the two things the dictionary genuinely knows
//   about it: what each of its WORDS means, and which recorded SENTENCES
//   contain it. Neither is a translation of the phrase, and the screen must not
//   present them as one, which is what `search.phraseWordsNote` says out loud.
//
// THE EXAMPLE SEARCH IS SQL-NARROWED AND TYPESCRIPT-DECIDED.
//   Postgres cannot fold a sentence the way `normalizeForLanguage` does, so it
//   cannot answer "does this sentence contain this phrase" by our own rules. An
//   `ilike` here would answer a DIFFERENT question, on unfolded text, and the
//   two answers would disagree on exactly the queries this feature exists for.
//
//   What SQL can do cheaply is narrow. A sentence containing every word of the
//   phrase mentions each of those words, and the Tatoeba importer attaches a
//   sentence to every headword it mentions through `example_headwords`. So the
//   junction supplies the candidates and `selectPhraseExamples` decides, on
//   folded text, with one implementation on both sides.
//
//   The candidate cap is the honest limit of that arrangement: a phrase whose
//   words are attached to more sentences than the cap can miss a match sitting
//   past it. It bounds recall, never correctness, and it is named rather than
//   inlined so the number is visible.

/** How many words of a phrase are looked up as headwords. Beyond this is noise. */
export const PHRASE_TOKEN_LIMIT = 6;

/** How many entries one word of a phrase contributes. The word is context, not the answer. */
export const PHRASE_HITS_PER_TOKEN = 3;

/** How many attached sentences are pulled back before the folded phrase test runs. */
export const PHRASE_EXAMPLE_CANDIDATES = 300;

/** How many sentences containing the phrase are shown. */
export const PHRASE_EXAMPLES_LIMIT = 5;

/** One word of a phrase, with the entries it resolves to on its own. */
export interface PhraseTokenMatch {
  /** The folded word, exactly as it was looked up. */
  token: string;
  hits: SearchHit[];
}

/** What the phrase branch answers with: the words, and the sentences. */
export interface PhraseSearchResult {
  /** The folded words of the phrase, each with its own entries. */
  tokens: PhraseTokenMatch[];
  /** Recorded sentences that contain the whole phrase, in order. */
  examples: SearchHitExample[];
}

/**
 * Sentences attached to any of a set of headwords, licence-filtered in SQL.
 *
 * This is the CANDIDATE query of the phrase branch, and it deliberately does
 * not test for the phrase. `selectPhraseExamples` is the decider, on folded
 * text, by the app's own per-language rules.
 */
export function phraseExampleCandidatesQuery(
  db: DictionaryDb,
  params: { headwordIds: string[]; from: LanguageCode; to: LanguageCode; limit: number },
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
    .where(
      and(
        inArray(exampleHeadwords.headwordId, params.headwordIds),
        // The phrase was folded by ONE language's rules, so a sentence in
        // another language cannot be tested against it honestly.
        eq(examples.languageCode, params.from),
        servedLicence(),
      ),
    )
    .orderBy(preferTargetLanguage(params.to), asc(examples.id))
    .limit(params.limit);
}

/**
 * Keep the candidate sentences that actually contain the phrase. Pure.
 *
 * Both sides go through `normalizeSentence`, so a phrase typed without German
 * umlauts still finds the sentence that has them, and a comma standing at the
 * phrase boundary does not hide it. Both sides are padded with a space before
 * the containment test, so `haus` is not reported as a match inside `hausboot`.
 *
 * @param rows The candidate sentences, in the order they should be considered.
 * @param phrase The folded phrase, its words separated by single spaces.
 * @param languageCode The language both sides are folded by.
 * @param cap How many sentences to keep.
 * @returns The matching sentences, de-duplicated, at most `cap` of them.
 */
export function selectPhraseExamples(
  rows: ExampleRow[],
  phrase: string,
  languageCode: LanguageCode,
  cap: number,
): SearchHitExample[] {
  const needle = ` ${phrase} `;
  const kept: SearchHitExample[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    if (kept.length >= cap) break;
    // The same sentence arrives once per headword it is attached to, and every
    // word of the phrase is one of those headwords.
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    if (!` ${normalizeSentence(row.text, languageCode)} `.includes(needle)) continue;
    kept.push({
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
  }
  return kept;
}

/**
 * Answer a multi-word query: every word's entries, and the sentences carrying
 * the whole phrase.
 *
 * The word lookups reuse `searchHeadwords` rather than a second query path, so
 * a word inside a phrase is forgiving of typos and diacritics in exactly the
 * same way it is on its own. They run in parallel because they are independent
 * and there are at most `PHRASE_TOKEN_LIMIT` of them.
 *
 * @param db The dictionary database handle.
 * @param params The raw query and the direction the lookup runs in.
 * @returns The per-word entries and the matching sentences. Either may be empty.
 * @throws If the query is a single word. The caller must branch on
 *   `normalizeQuery(...).isPhrase`, because this path would show that one word
 *   as its own context and find only sentences it is already listed under.
 */
export async function searchPhrase(
  db: DictionaryDb,
  params: SearchHeadwordsParams,
): Promise<PhraseSearchResult> {
  const query = normalizeQuery(params.q, params.from);
  if (!query.isPhrase) {
    throw new Error(
      `searchPhrase was called with "${params.q}", which normalizes to a single word. The ` +
        'caller must branch on `normalizeQuery(...).isPhrase` and send a single word to ' +
        '`searchHeadwords` instead.',
    );
  }
  const lookedUp = query.tokens.slice(0, PHRASE_TOKEN_LIMIT);
  const tokens: PhraseTokenMatch[] = await Promise.all(
    lookedUp.map(async (token) => ({
      token,
      hits: await searchHeadwords(db, {
        q: token,
        from: params.from,
        to: params.to,
        limit: PHRASE_HITS_PER_TOKEN,
      }),
    })),
  );

  const headwordIds = tokens.flatMap((match) => match.hits.map((hit) => hit.headwordId));
  // No word of the phrase is in the dictionary, so no sentence is attached to
  // any of them and the candidate query would have nothing to narrow by.
  if (headwordIds.length === 0) return { tokens, examples: [] };

  const candidates = await phraseExampleCandidatesQuery(db, {
    headwordIds,
    from: params.from,
    to: params.to,
    limit: PHRASE_EXAMPLE_CANDIDATES,
  });
  const matching = selectPhraseExamples(
    candidates,
    query.tokens.join(' '),
    params.from,
    PHRASE_EXAMPLES_LIMIT,
  );
  return { tokens, examples: matching };
}
