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
 * Split a sentence into normalized word tokens.
 *
 * Order is first appearance, and duplicates are removed. Deterministic order
 * matters because the token array goes into a SQL statement, and two runs over
 * the same sentence must produce the same statement.
 *
 * @param sentence One sentence of running text.
 * @returns Its distinct tokens, in stored form, in order of first appearance.
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

/**
 * Normalize a word form the way its own language would.
 *
 * V1 BEHAVIOUR IS `normalizeLemma` FOR EVERY LANGUAGE, and the parameter is
 * deliberately ignored. The function exists now because the search path has to
 * CALL it now: a seam introduced later would have to be threaded through every
 * call site at the same time as the rules land, and the call sites are the part
 * that gets forgotten.
 *
 * THE FAILURE IT IS FOR
 *   Turkish. `'I'.toLowerCase()` gives `'i'`, but Turkish lowercases `I` to
 *   `ı`. A Turkish query for `IŞIK` therefore normalizes to `isik`, while the
 *   stored form of `ışık` is `isik` only because the same wrong rule ran on
 *   import. The two agree today by symmetry, and they stop agreeing the moment
 *   either side learns the real rule. Words whose only difference is the dot
 *   are already unreachable from each other.
 *
 * TODO(M173/04): that spec owns the locale-aware casing rules, for both the
 * stored form and the query form, and owns the re-import the change implies.
 * Do not add Turkish casing here on its own: changing only the query side
 * breaks the equality against every row already in the table.
 *
 * @param value A written word form.
 * @param languageCode The language the form is being read as. Unused in v1.
 * @returns The stored form to compare against `headwords.lemma_normalized`.
 */
export function normalizeForLanguage(value: string, languageCode: string): string {
  // Named and discarded rather than omitted from the signature: the parameter
  // is the seam, and a caller that does not pass a language is the bug this is
  // here to prevent.
  void languageCode;
  return normalizeLemma(value);
}
