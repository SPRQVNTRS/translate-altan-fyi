/**
 * Which language a query is IN, and which language it should be translated TO.
 *
 * TWO LAYERS, ON PURPOSE
 *   `chooseDirection` is pure: it takes the URL parameters, the UI language and
 *   an already-counted map of exact hits per language, and returns the
 *   decision. `detectLanguage` runs the one database query that produces those
 *   counts and then delegates. The precedence rules are the part that is easy
 *   to get subtly wrong, so they are the part that is testable without a
 *   database.
 *
 * THE DECISION IS NOT DECORATION
 *   The direction chosen here selects which side of the dictionary is searched.
 *   If it reaches only a label in the header and not the query, the page shows
 *   a correct-looking chip above results drawn from the wrong language. The
 *   integration test asserts the whole chain, not the returned object.
 */

import { and, count, eq, inArray } from 'drizzle-orm';
import { headwords, sources } from '#drizzle/schema';
import { SERVED_LICENCES } from './licences';
import { normalizeLemma } from './normalize';
import type { DictionaryDb } from './queries.server';

/**
 * The languages this dictionary serves.
 *
 * The order is also the TIE-BREAK order, see `chooseDirection`.
 */
export const SERVED_LANGUAGES = ['en', 'de', 'tr', 'es'] as const;

/** One of the four served languages. */
export type LanguageCode = (typeof SERVED_LANGUAGES)[number];

/** The direction a lookup runs in. */
export interface Direction {
  from: LanguageCode;
  to: LanguageCode;
  /** `false` when the caller supplied `from` in the URL, `true` when we guessed. */
  detected: boolean;
}

/** The inputs the pure decision needs. */
export interface ChooseDirectionInput {
  q: string;
  /** `from` as it arrived in the URL. Anything not in `SERVED_LANGUAGES` is ignored. */
  from?: string | null;
  /** `to` as it arrived in the URL. Same rule. */
  to?: string | null;
  /** The language the interface is being shown in. */
  uiLanguage?: string | null;
  /** Exact `lemma_normalized` matches per language, already counted. */
  exactHitsByLanguage: Partial<Record<LanguageCode, number>>;
}

/** What `detectLanguage` needs beyond the database handle. */
export interface DetectLanguageParams {
  q: string;
  from?: string | null;
  to?: string | null;
  uiLanguage?: string | null;
}

/** Narrow an arbitrary URL or header value to a served language. */
export function isServedLanguage(value: string | null | undefined): value is LanguageCode {
  return SERVED_LANGUAGES.some((code) => code === value);
}

/**
 * The other half of a language's pair.
 *
 * German and English are the pair this dictionary is built around, so each
 * points at the other. Turkish and Spanish are served against English, because
 * English is the only language they both have coverage against.
 */
function partnerOf(language: LanguageCode): LanguageCode {
  if (language === 'de') return 'en';
  if (language === 'en') return 'de';
  return 'en';
}

/**
 * The scripts that belong to exactly one served language.
 *
 * `ä ö ü` ARE NOT GERMAN-ONLY. Turkish writes `ö` and `ü` too, and `ş`-less
 * Turkish words like `gün` or `göz` carry nothing else to tell them apart. That
 * is precisely why the DATABASE COUNT RUNS FIRST: a real hit in the Turkish
 * headword table settles the question that these characters cannot. The
 * heuristic only speaks when the dictionary has no opinion at all, and German
 * is the likelier reading of an umlaut for this product's audience.
 */
const GERMAN_CHARACTERS = /[ßäöüÄÖÜ]/u;
/** Turkish-only letters. `I` alone is not one: English is full of it. */
const TURKISH_CHARACTERS = /[ğĞışŞİ]/u;
/** Spanish-only letters and the inverted punctuation. */
const SPANISH_CHARACTERS = /[ñÑ¿¡]/u;

/** The character heuristic, or `null` when the query carries no signal. */
function guessFromCharacters(q: string): LanguageCode | null {
  if (GERMAN_CHARACTERS.test(q)) return 'de';
  if (TURKISH_CHARACTERS.test(q)) return 'tr';
  if (SPANISH_CHARACTERS.test(q)) return 'es';
  return null;
}

/**
 * The language with the most exact hits, or `null` when there are none.
 *
 * THE TIE-BREAK IS `SERVED_LANGUAGES` ORDER, and it is a `>` rather than a
 * `>=` that makes it so: the first language in that array wins a tie. The
 * requirement is only that the answer be the SAME on every request, because a
 * tie broken by row order would move the whole page between two identical
 * requests and would be unreproducible in a bug report. Declaration order is
 * fixed in source, so it satisfies that at no cost.
 */
function bestByExactHits(
  exactHitsByLanguage: Partial<Record<LanguageCode, number>>,
): LanguageCode | null {
  let best: LanguageCode | null = null;
  let bestHits = 0;

  for (const language of SERVED_LANGUAGES) {
    const hits = exactHitsByLanguage[language] ?? 0;
    if (hits > bestHits) {
      best = language;
      bestHits = hits;
    }
  }

  return best;
}

/**
 * Decide the direction from already-gathered evidence.
 *
 * Precedence, highest first:
 *   1. A valid `from` in the URL. It is the reader's own statement, so nothing
 *      overrules it and no evidence is even consulted.
 *   2. The language with the most exact headword matches.
 *   3. The character heuristic.
 *   4. The pair partner of the UI language.
 *
 * @param input The URL parameters, the UI language, and the exact-hit counts.
 * @returns The direction, with `detected` telling the caller which of the two
 *   cases it is looking at.
 */
export function chooseDirection(input: ChooseDirectionInput): Direction {
  const statedFrom = isServedLanguage(input.from) ? input.from : null;
  const from =
    statedFrom ??
    bestByExactHits(input.exactHitsByLanguage) ??
    guessFromCharacters(input.q) ??
    partnerOf(isServedLanguage(input.uiLanguage) ? input.uiLanguage : 'en');

  const statedTo = isServedLanguage(input.to) ? input.to : null;
  // A `to` equal to `from` is corrected rather than honoured. A translation is
  // an edge between two DIFFERENT languages, so `de -> de` names no edge that
  // exists and would return an empty page for a query that has answers. `from`
  // is the side that wins, because it is the side the query searches: keeping
  // it and repairing `to` changes which answers are shown, while keeping `to`
  // would change which word was looked up.
  const to = statedTo !== null && statedTo !== from ? statedTo : partnerOf(from);

  return { from, to, detected: statedFrom === null };
}

/**
 * Count exact `lemma_normalized` matches per language, licence-filtered in SQL.
 *
 * ONE GROUPED STATEMENT, not one per language. Four statements would cost four
 * round trips on the hot path of every un-directed query, and would leave the
 * four counts free to be taken at four different moments.
 *
 * The query form is normalized with `normalizeLemma` rather than
 * `normalizeForLanguage`, because at this point the language is exactly what is
 * not yet known. Returned un-awaited so a test can read the statement.
 */
export function exactHitsByLanguageQuery(db: DictionaryDb, q: string) {
  return db
    .select({ languageCode: headwords.languageCode, hits: count() })
    .from(headwords)
    .innerJoin(sources, eq(headwords.sourceId, sources.id))
    .where(
      and(
        eq(headwords.lemmaNormalized, normalizeLemma(q)),
        inArray(headwords.languageCode, [...SERVED_LANGUAGES]),
        inArray(sources.licence, [...SERVED_LICENCES]),
      ),
    )
    .groupBy(headwords.languageCode);
}

/**
 * Detect the direction, consulting the database only when it is needed.
 *
 * A valid `from` in the URL short-circuits before any query runs: the answer
 * cannot change, so the round trip would be pure cost.
 *
 * @param db The dictionary database handle.
 * @param params The query text and the URL and UI parameters.
 * @returns The direction to search in.
 */
export async function detectLanguage(
  db: DictionaryDb,
  params: DetectLanguageParams,
): Promise<Direction> {
  if (isServedLanguage(params.from)) {
    return chooseDirection({ ...params, exactHitsByLanguage: {} });
  }

  if (params.q.trim() === '') {
    return chooseDirection({ ...params, exactHitsByLanguage: {} });
  }

  const rows = await exactHitsByLanguageQuery(db, params.q);
  // Built in a Map and handed over as an object: an accumulator object built by
  // assignment is an open dictionary the linter has to reason about, and a Map
  // says the same thing without one.
  const hits = new Map<LanguageCode, number>();
  for (const row of rows) {
    if (!isServedLanguage(row.languageCode)) continue;
    hits.set(row.languageCode, Number(row.hits));
  }

  return chooseDirection({ ...params, exactHitsByLanguage: Object.fromEntries(hits) });
}
