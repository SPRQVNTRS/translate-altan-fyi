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
