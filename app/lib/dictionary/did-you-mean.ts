/**
 * The third layer of forgiving input: a suggestion the reader has to accept.
 *
 * THE THREE LAYERS, AND WHY THIS ONE IS SEPARATE
 *   Exact match first, then trigram similarity above `SIMILARITY_THRESHOLD`.
 *   Both of those RETURN RESULTS: the reader asked a question and got answers.
 *   This module runs only when both found nothing, and it does not return a
 *   result. It returns a WORD TO OFFER, which the route renders as a link the
 *   reader clicks. Nothing here is ever applied on the reader's behalf.
 *
 *   That is not a UI nicety. A silently applied correction produces a page of
 *   perfectly confident translations of a word nobody looked up, and there is
 *   nothing on the screen to tell the reader that happened. The click is the
 *   consent, and it is also the record: the corrected query lands in the URL,
 *   so the reader can see what was searched and go back.
 *
 * IT MUST NEVER ECHO THE QUERY
 *   `feedback_fallback_hides_a_broken_derived_key` is the failure this guards
 *   against. A suggestion path that fell back to returning its own input would
 *   render "did you mean: hauss" under a search for `hauss`, which looks like a
 *   working feature and is a completely broken one. So the last thing
 *   `suggestDidYouMean` does is compare the candidate's folded form against the
 *   folded query and return `null` when they are equal. There is no branch in
 *   this file that can return the raw query.
 *
 * THE DATABASE IS A PARAMETER, NEVER AN IMPORT, exactly as in
 * `queries.server.ts` and `search.server.ts`. `drizzle/db.ts` opens a pool at
 * module load, so importing it here would open one in every process that
 * touches this module.
 *
 * THIS FILE HAS NO `.server` SUFFIX AND STILL NEVER REACHES THE CLIENT. It is
 * imported by the route loader only, alongside `search.server.ts`, which is the
 * module that actually pins the boundary.
 */

import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { headwords, sources } from '#drizzle/schema';
import type { LanguageCode } from './detect-language';
import { SERVED_LICENCES } from './licences';
import { normalizeForLanguage, normalizeQuery } from './normalize';
import type { DictionaryDb } from './queries.server';

/**
 * The bar a SUGGESTION must clear, deliberately below the bar a RESULT must
 * clear (`SIMILARITY_THRESHOLD`, 0.35, in `search.server.ts`).
 *
 * The two numbers describe two different promises. A result is shown as an
 * answer, so it has to be close enough that a reader takes it seriously
 * unprompted. A suggestion is shown as a question, so the band between the two
 * values is exactly the space where "this is probably not it, but have a look"
 * is the honest thing to say.
 *
 * 0.3 is also `pg_trgm.similarity_threshold`'s own default, which the `%`
 * operator below compares against. That agreement is deliberate: the operator
 * is what makes this an index scan, and setting this constant BELOW the GUC
 * would let the operator quietly discard candidates the explicit comparison
 * would have accepted. If a deployment ever raises that GUC, this query narrows
 * with it, and the symptom is a missing suggestion rather than a wrong one.
 */
export const SUGGESTION_THRESHOLD = 0.3;

/** What the caller has to supply beyond the database handle. */
export interface DidYouMeanParams {
  /** The reader's query, raw. Folded here, never by the caller. */
  query: string;
  /** The language the query is read as, the same one the search branch used. */
  languageCode: LanguageCode;
}

/**
 * The single closest headword to a folded query, above `SUGGESTION_THRESHOLD`.
 *
 * Returned un-awaited so a test can read the generated statement, which is how
 * `tests/unit/dictionary-licences.test.ts` proves the licence filter is in the
 * SQL rather than in a `.filter()` a code path can forget.
 *
 * The predicate is written twice for the reason `fuzzyHeadwordsQuery` spells
 * out: `%` is the operator `headwords_lemma_normalized_trgm_idx` answers and is
 * the only reason this is not a sequential scan, while the explicit
 * `similarity(...) >` comparison is what DECIDES the result, against a number
 * this code owns instead of a session variable it cannot see.
 */
export function nearestHeadwordQuery(
  db: DictionaryDb,
  params: { normalizedQuery: string; languageCode: LanguageCode },
) {
  const score = sql<number>`similarity(${headwords.lemmaNormalized}, ${params.normalizedQuery})`;
  return db
    .select({
      lemma: headwords.lemma,
      lemmaNormalized: headwords.lemmaNormalized,
      similarity: score,
    })
    .from(headwords)
    .innerJoin(sources, eq(headwords.sourceId, sources.id))
    .where(
      and(
        sql`${headwords.lemmaNormalized} % ${params.normalizedQuery}`,
        sql`${score} > ${SUGGESTION_THRESHOLD}`,
        eq(headwords.languageCode, params.languageCode),
        inArray(sources.licence, [...SERVED_LICENCES]),
      ),
    )
    // The lemma leg is not decoration. Two rows can score identically, and
    // without a second ordering key Postgres is free to return either one, so
    // the same miss would suggest a different word between two page loads.
    .orderBy(desc(score), asc(headwords.lemma))
    .limit(1);
}

/**
 * The word to offer a reader whose query matched nothing.
 *
 * CALL THIS ONLY AFTER THE SEARCH RETURNED NOTHING. It does not check that, and
 * it cannot: it has no view of what the search found. Calling it alongside a
 * page of results would put a "did you mean" over answers the reader already
 * has, which reads as the app doubting its own output.
 *
 * @param db The dictionary database handle.
 * @param params The raw query and the language the search ran in.
 * @returns The headword to offer, in its WRITTEN form, or `null` when there is
 *   nothing honest to offer: no query, a phrase, no neighbour above the
 *   threshold, or a neighbour that is the query itself.
 */
export async function suggestDidYouMean(
  db: DictionaryDb,
  params: DidYouMeanParams,
): Promise<string | null> {
  const query = normalizeQuery(params.query, params.languageCode);
  if (query.normalized === '') return null;
  // A phrase has no single headword to be a near miss of. Offering the closest
  // headword to a whole sentence would suggest one word in place of several,
  // which is not a spelling correction, it is a different search.
  if (query.isPhrase) return null;

  const [nearest] = await nearestHeadwordQuery(db, {
    normalizedQuery: query.normalized,
    languageCode: params.languageCode,
  });
  if (!nearest) return null;

  // THE GUARD THIS MODULE EXISTS FOR. The comparison is on the FOLDED forms,
  // not the written ones: `Haus` and `haus` are one suggestion and a suggestion
  // that only differs from the query in its casing is not a correction. The
  // stored column is folded already, so this compares like with like without
  // trusting that it was written by the rules in force today.
  const foldedSuggestion = normalizeForLanguage(nearest.lemma, params.languageCode);
  if (foldedSuggestion === query.normalized) return null;

  return nearest.lemma;
}
