/**
 * The single definition of a normalized word form.
 *
 * WHY THIS LIVES UNDER `app/lib/dictionary/` AND NOT UNDER `cli/`
 *   It was an importer detail for exactly as long as only the importer used it.
 *   The search path now normalizes the query with the SAME function that wrote
 *   `headwords.lemma_normalized` on import, because a lookup compares the two
 *   values with a plain `=`. Two copies of this logic would not fail: they would
 *   quietly move rows out of reach of the queries that should find them, on the
 *   small share of words where the copies disagree. So there is one definition,
 *   it lives on the side that serves readers, and `cli/lib/importers/normalize.ts`
 *   re-exports it.
 *
 * THIS IS NOT POSTGRES `unaccent`
 *   It looks like it and it is not it. `unaccent` works from a rule table that
 *   ships with the extension, and it maps a handful of characters this code
 *   leaves alone. Anything normalized here and compared against something
 *   normalized in SQL would therefore disagree on the edges, quietly, on a
 *   small share of rows.
 *
 *   So the Tatoeba attachment join normalizes BOTH sides in TypeScript. It
 *   tokenizes the sentence here with `tokenizeForLanguage`, and passes the
 *   token array into SQL to be matched against the stored
 *   `headwords.lemma_normalized`, which `normalizeForLanguage` produced on
 *   import. One implementation on both sides, so the two cannot drift apart.
 *
 * TURKISH DOTTED AND DOTLESS I ARE NOT HANDLED HERE, BY DESIGN
 *   `'I'.toLowerCase()` gives `'i'`. In Turkish the lowercase of `I` is `ı`, so
 *   that result is wrong, and `normalizeLemma` still produces it. That is not a
 *   gap any more: it is what the LANGUAGE-BLIND path is allowed to do.
 *
 *   The rule now lives in `./locale-fold.ts`, and `normalizeForLanguage` below
 *   is how a caller reaches it. `normalizeLemma` survives for exactly one
 *   caller, `detect-language.ts`, whose whole job is to answer "which language
 *   is this?" and which therefore has no language to fold by. Its counts are a
 *   heuristic and stay one.
 *
 *   Everything that stores or looks up a lemma calls `normalizeForLanguage`.
 *   `normalizeLemma` is NOT the stored form of a headword any more, so do not
 *   compare its output against `headwords.lemma_normalized` and expect a hit.
 */

import { foldForSearch } from './locale-fold';

/** Combining marks, which is what an accent decomposes into under NFD. */
const COMBINING_MARKS = /\p{M}+/gu;

/** Runs of whitespace, collapsed to one space. */
const WHITESPACE_RUN = /\s+/gu;

/**
 * Anything that is not a letter, a digit, an apostrophe or a hyphen.
 *
 * Both apostrophes are kept, because a dump writes "don't" with either one and
 * splitting on them would turn one word into two.
 */
const NON_WORD = /[^\p{L}\p{N}'’-]+/gu;

/**
 * The LANGUAGE-BLIND normalized form, for the one caller that has no language.
 *
 * THIS IS NOT THE STORED FORM. `headwords.lemma_normalized` is written by
 * `normalizeForLanguage`, and for Turkish and German the two now differ:
 * `normalizeLemma('ışık')` is `'ısık'` where the stored form is `'isik'`, and
 * `normalizeLemma('Straße')` is `'straße'` where the stored form is `'strasse'`.
 * Comparing this output against the column finds nothing on exactly those rows.
 *
 * Its one legitimate caller is `detect-language.ts`, which counts exact hits per
 * language in order to GUESS the language, and so cannot pass one. Those counts
 * are a heuristic, and a Turkish or German row this misses only costs the guess
 * a vote, never a search result.
 *
 * @param value A written word form, in any case and with any accents.
 * @returns The lowercased, unaccented, whitespace-collapsed form.
 */
export function normalizeLemma(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFD')
    .replace(COMBINING_MARKS, '')
    .replace(WHITESPACE_RUN, ' ')
    .trim();
}

/**
 * Normalize a word form the way its own language would. THIS IS THE ONE
 * FUNCTION that produces both the stored form and the query form.
 *
 * WHY ONE FUNCTION AND NOT TWO THAT AGREE
 *   `headwords.lemma_normalized` is written on import and compared with a plain
 *   `=` at search time. Two implementations that agree today would not fail
 *   when they stopped agreeing; they would move rows out of reach of the
 *   queries that should find them, silently, on whatever small share of words
 *   the two disagreed about. So there is one function, both sides call it, and
 *   `tests/unit/locale-fold.test.ts` asserts the importer's import path and the
 *   search path resolve to it row by row.
 *
 *   The corollary is the one that bites: changing the folding changes the
 *   STORED form, so every existing row has to be rewritten in the same change.
 *   That is what `drizzle/data-migrations/migrations/2026-09-02-lemma-normalized-locale-fold.ts`
 *   is for. A folding change shipped without it leaves the table holding keys
 *   the new query form can no longer produce.
 *
 * WHAT IT DOES
 *   Casing and diacritics are delegated to `foldForSearch` in `./locale-fold.ts`,
 *   which holds the per-language rule table. Whitespace collapsing and trimming
 *   stay here, because the shape of a stored lemma is not a locale question.
 *
 * @param value A written word form.
 * @param languageCode The language the form is being read as. Must be served.
 * @returns The stored form to compare against `headwords.lemma_normalized`.
 * @throws If the language has no fold rules. Folding an unknown language by
 *   English rules would store a key nothing looks up, and report nothing.
 */
export function normalizeForLanguage(value: string, languageCode: string): string {
  return foldForSearch(value, languageCode).replace(WHITESPACE_RUN, ' ').trim();
}

/**
 * Split a sentence into normalized word tokens, folded by its own language.
 *
 * This is `tokenize` with the language supplied, and it is what the Tatoeba
 * attachment join calls: the tokens it emits are compared against
 * `headwords.lemma_normalized`, which `normalizeForLanguage` wrote. A token
 * folded by different rules than the column would simply never match.
 *
 * @param sentence One sentence of running text.
 * @param languageCode The language the sentence is written in. Must be served.
 * @returns Its distinct tokens, in stored form, in order of first appearance.
 */
export function tokenizeForLanguage(sentence: string, languageCode: string): string[] {
  const seen = new Set<string>();
  const tokens: string[] = [];

  for (const piece of sentence.split(NON_WORD)) {
    const token = normalizeForLanguage(piece, languageCode);
    if (token === '') continue;
    if (seen.has(token)) continue;
    seen.add(token);
    tokens.push(token);
  }

  return tokens;
}

/**
 * Punctuation and quotes sitting at the START or the END of a string.
 *
 * A reader pastes `"Haus"`, types `Haus?`, or a speech recogniser hands back
 * `Haus.` with a full stop it invented. None of those characters belong to the
 * word, and none of them are in the stored lemma, so an exact lookup with them
 * attached finds nothing at all.
 *
 * INNER punctuation is deliberately NOT matched. `don't` and `Sankt-Peter` are
 * one word each, and a rule that stripped their apostrophe or hyphen would turn
 * a lookup into two lookups for neither of them.
 */
const SURROUNDING_PUNCTUATION = /^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu;

/**
 * The result of reading a raw search box into something the query can use.
 *
 * `normalized` and `tokens` are two different answers to two different
 * questions, and the difference matters:
 *
 *   - `normalized` is the SINGLE-WORD SEARCH KEY, compared with `=` against
 *     `headwords.lemma_normalized`. It is stripped only at the two ends of the
 *     whole query, because the stored form was written by
 *     `normalizeForLanguage`, which strips nothing, and every extra repair
 *     applied to one side and not the other moves rows out of reach.
 *   - `tokens` is the PHRASE BRANCH's word list, and each entry is looked up as
 *     a headword on its own. A word there carries no punctuation from its
 *     neighbours, so `hello, world` yields `hello` and `world` rather than
 *     `hello,`.
 */
export interface NormalizedQuery {
  /** The text exactly as the reader typed or spoke it. Never shown as a suggestion. */
  readonly raw: string;
  /** The folded single-word search key. Empty when the query held no letters at all. */
  readonly normalized: string;
  /** The folded words of the query, each cleaned of punctuation at its own edges. */
  readonly tokens: readonly string[];
  /** True when the query holds more than one word, which is the phrase branch's condition. */
  readonly isPhrase: boolean;
}

/**
 * Split a value into its words, cleaning punctuation off each word's edges.
 *
 * This is the ONE token splitter, and both `isPhrase` and `normalizeQuery` go
 * through it. Two splitters that agreed today would disagree eventually, and
 * the visible symptom would be a query routed down the single-word branch while
 * the phrase branch counted two words, or the reverse.
 */
function splitTokens(value: string): string[] {
  const tokens: string[] = [];
  for (const piece of value.split(WHITESPACE_RUN)) {
    const token = piece.replace(SURROUNDING_PUNCTUATION, '');
    if (token === '') continue;
    tokens.push(token);
  }
  return tokens;
}

/**
 * Whether a value is a PHRASE rather than a single word.
 *
 * Folding never changes how many words a string has, so this answers the same
 * for the raw text and for the folded text, and a caller may pass either.
 *
 * @param value A search box's contents, raw or already folded.
 * @returns True when the value holds two or more words.
 */
export function isPhrase(value: string): boolean {
  return splitTokens(value).length > 1;
}

/**
 * Read a raw search box into the forms the search path needs.
 *
 * WHY THE QUERY GETS ITS OWN FUNCTION AND NOT JUST `normalizeForLanguage`
 *   `normalizeForLanguage` is the function that WROTE `lemma_normalized`, and
 *   it must keep doing exactly what it did, byte for byte, or every stored row
 *   moves out of reach. So the query-side repairs a reader needs, dropping the
 *   quotes they pasted and the question mark they typed, cannot go in there.
 *   They go here, on the query side only, and the divergence they create is
 *   named rather than hidden: a lemma that genuinely ENDS in punctuation is no
 *   longer reachable by exact match, and reaches the reader through the fuzzy
 *   branch instead.
 *
 * IT NEVER REPAIRS SPELLING, AND THAT IS THE POINT
 *   Nothing here fixes a typo. `Hauss` folds to `hauss` and stays there. Typos
 *   are the trigram branch's job and, when that finds nothing either, the did
 *   you mean suggestion's job, which the reader has to accept by clicking. A
 *   normaliser that quietly turned `hauss` into `haus` would be applying an
 *   unaccepted correction, and a wrong one would read as a wrong translation.
 *
 * @param raw The search box's contents, as typed or as the recogniser heard it.
 * @param languageCode The language the query is read as. Must be served.
 * @returns The search key, the word list, and whether this is a phrase.
 */
export function normalizeQuery(raw: string, languageCode: string): NormalizedQuery {
  const collapsed = raw.replace(WHITESPACE_RUN, ' ').trim();
  const trimmedEnds = collapsed.replace(SURROUNDING_PUNCTUATION, '');
  const normalized = normalizeForLanguage(trimmedEnds, languageCode);
  const tokens = splitTokens(normalized);
  return { raw, normalized, tokens, isPhrase: tokens.length > 1 };
}

/**
 * Fold a whole sentence into the space-separated word sequence a phrase is
 * matched against.
 *
 * This is what makes "does this sentence contain this phrase" answerable. Both
 * sides go through the SAME `splitTokens` and the SAME `normalizeForLanguage`,
 * so a phrase typed without German umlauts still finds a sentence that has
 * them, and a comma standing between two words does not hide the phrase that
 * spans it.
 *
 * The containment test itself belongs to the caller, and it must pad both sides
 * with a space, so that `haus` does not report a match inside `hausboot`.
 *
 * @param sentence One sentence of running text.
 * @param languageCode The language the sentence is written in. Must be served.
 * @returns Its folded words, separated by single spaces, punctuation removed.
 */
export function normalizeSentence(sentence: string, languageCode: string): string {
  return splitTokens(normalizeForLanguage(sentence, languageCode)).join(' ');
}
