/**
 * The single definition of a normalized word form.
 *
 * THIS IS NOT POSTGRES `unaccent`
 *   It looks like it and it is not it. `unaccent` works from a rule table that
 *   ships with the extension, and it maps a handful of characters this code
 *   leaves alone. Anything normalized here and compared against something
 *   normalized in SQL would therefore disagree on the edges, quietly, on a
 *   small share of rows.
 *
 *   So the Tatoeba attachment join normalizes BOTH sides in TypeScript. It
 *   tokenizes the sentence here, normalizes the tokens here, and passes the
 *   token array into SQL to be matched against the stored
 *   `headwords.lemma_normalized`, which this same function produced on import.
 *   One implementation on both sides, so the two cannot drift apart.
 *
 * TURKISH DOTTED AND DOTLESS I ARE NOT HANDLED
 *   `'I'.toLowerCase()` gives `'i'`. In Turkish the lowercase of `I` is `ı`, so
 *   that result is wrong. `'İ'` decomposes to `I` plus a combining dot, the dot
 *   is stripped as a mark, and the result is `'i'`, which happens to be right,
 *   by accident rather than by rule.
 *
 *   Turkish casing needs locale-aware rules and a decision about what the
 *   stored form should be, and that is a later spec's job. Until then the
 *   limitation is named here rather than papered over: Turkish lookup will miss
 *   on words whose only difference is the dot.
 */

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
 * The stored form of a lemma. This is what `headwords.lemma_normalized` holds,
 * and what every lookup compares against.
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
 * Split a sentence into normalized word tokens.
 *
 * Order is first appearance, and duplicates are removed. Deterministic order
 * matters because the token array goes into a SQL statement, and two runs over
 * the same sentence must produce the same statement.
 */
export function tokenize(sentence: string): string[] {
  const seen = new Set<string>();
  const tokens: string[] = [];

  for (const piece of sentence.split(NON_WORD)) {
    const token = normalizeLemma(piece);
    if (token === '') continue;
    if (seen.has(token)) continue;
    seen.add(token);
    tokens.push(token);
  }

  return tokens;
}
