/**
 * Language-aware lowercasing and search folding.
 *
 * WHY CASE FOLDING CANNOT BE ONE RULE
 *   `'I'.toLowerCase()` is `'i'`. In Turkish that is a different letter and a
 *   different word: Turkish pairs `I` with `ı` and `İ` with `i`, so the
 *   locale-independent rule turns `IŞIK` ("light") into a string no Turkish
 *   reader ever typed. JavaScript already knows the real rule, but only when it
 *   is told the language: `'I'.toLocaleLowerCase('tr')` is `'ı'`. That argument
 *   is the whole reason this module exists.
 *
 * CASING AND FOLDING ARE TWO DIFFERENT ANSWERS
 *   `lowerCaseFor` is the TRUE lowercase of a word in its own language. It is
 *   what a displayed form should use, and for Turkish it keeps `ı` and `i`
 *   apart, because they are different letters.
 *
 *   `foldForSearch` is the SEARCH KEY, and it deliberately loses information.
 *   A Turkish speaker on an English keyboard types `isik` for `ışık` and
 *   `igdir` for `Iğdır`, so all four Turkish i letters collapse onto plain `i`
 *   and `ç ğ ö ş ü` collapse onto `c g o s u`. That trades precision for
 *   recall, on purpose: two Turkish words whose only difference is a dot now
 *   share one search key, and both are returned. A reader who sees two results
 *   picks the right one; a reader who sees none has no way forward at all.
 *
 * THE SAME TRADE, PER LANGUAGE, WITH DIFFERENT ANSWERS
 *   German folds `ß` to `ss`, which is the spelling reform's own equivalence
 *   and the form a keyboard without `ß` produces. It is length-changing, so a
 *   character map alone gets it wrong, which is why the table below holds
 *   strings and not characters.
 *
 *   Spanish folds `ñ` to `n` and strips accents. THE PRECISION COST IS REAL:
 *   `año` ("year") and `ano` ("anus") become one search key, as do `papá` and
 *   `papa`. Recall wins anyway, because the reader most likely to need this app
 *   is the one who does not know the accent yet and cannot type `ñ` at all. The
 *   two words still exist as separate rows with separate entries; only the key
 *   that finds them is shared.
 *
 *   English has no rule of its own beyond the shared accent strip, which is
 *   what the loanwords (`café`, `naïve`) need.
 *
 * THE TABLE IS THE SPECIFICATION
 *   Every fold a language performs is written out below, including the ones the
 *   shared combining-mark strip would also catch (`ä ö ü`, `é`, `ñ`). The
 *   redundancy is deliberate: a reader must be able to answer "what does this
 *   language do to this letter" by reading one entry, not by knowing which
 *   characters Unicode happens to decompose. `ç`, `ğ` and `ş` DO decompose;
 *   `ı` and `ß` do not. That is not a distinction anyone should have to carry.
 *
 * WHERE THIS IS CALLED FROM
 *   Nowhere directly, except `normalize.ts`. `normalizeForLanguage` is the one
 *   function that writes `headwords.lemma_normalized` on import and folds the
 *   query at search time, and it delegates here. Keeping the delegation
 *   one-way is what stops a second folding implementation from appearing next
 *   to a call site.
 */

/** Combining marks, which is what an accent decomposes into under NFD. */
const COMBINING_MARKS = /\p{M}+/gu;

/**
 * One language's casing locale and its explicit fold pairs.
 *
 * `caseLocale` is passed straight to `toLocaleLowerCase`. `folds` is applied to
 * the ALREADY LOWERCASED string, in order, before the shared mark strip.
 */
type FoldRule = {
  readonly caseLocale: string;
  readonly folds: ReadonlyArray<readonly [from: string, to: string]>;
};

/**
 * The per-language rule table for the v1 languages: en, de, tr and es.
 *
 * A language absent from this table has no rule, and `foldForSearch` throws
 * rather than quietly folding it as English. A search key produced by the wrong
 * language's rules does not fail: it silently indexes a word under a key
 * nothing will ever look up.
 */
const FOLD_RULES = {
  /** English: the plain fold. Accents on loanwords come off with the shared mark strip. */
  en: {
    caseLocale: 'en',
    folds: [],
  },

  /**
   * German. `ß` folds to `ss`, the equivalence German spelling itself uses and
   * the form produced by a keyboard that has no `ß` key. The umlauts fold to
   * their BASE letters (`ä` to `a`), not to the `ae` digraph: a reader without
   * an umlaut key types `Grun`, not `Gruen`, far more often.
   */
  de: {
    caseLocale: 'de',
    folds: [
      ['ß', 'ss'],
      ['ä', 'a'],
      ['ö', 'o'],
      ['ü', 'u'],
    ],
  },

  /**
   * Turkish. `toLocaleLowerCase('tr')` has already mapped `I` to `ı` and `İ` to
   * `i` by the time these run, which is the correct case pairing and the whole
   * point of doing the casing per language. The remaining `ı` to `i` then
   * collapses ALL FOUR i letters (`ı I i İ`) onto plain `i` for the search key.
   *
   * That collapse is the search key ONLY. `lowerCaseFor(value, 'tr')` still
   * keeps `ı` and `i` apart, so nothing displayed is damaged by it.
   */
  tr: {
    caseLocale: 'tr',
    folds: [
      ['ı', 'i'],
      ['ç', 'c'],
      ['ğ', 'g'],
      ['ö', 'o'],
      ['ş', 's'],
      ['ü', 'u'],
    ],
  },

  /**
   * Spanish. `ñ` folds to `n` and the accents come off. This MERGES genuinely
   * different words (`año` and `ano`, `papá` and `papa`) under one search key.
   * Recall is chosen over precision here: the reader who needs the lookup is
   * usually the one who cannot type the tilde.
   */
  es: {
    caseLocale: 'es',
    folds: [['ñ', 'n']],
  },
  // `satisfies` rather than an annotation: the keys stay literal, so
  // `FoldLanguage` below IS the table's own key set and cannot fall behind it.
} satisfies Record<string, FoldRule>;

/** The languages the table actually holds rules for. Derived, never restated. */
type FoldLanguage = keyof typeof FOLD_RULES;

/** Whether a language code has fold rules, and can therefore be folded at all. */
export function isFoldLanguage(languageCode: string): languageCode is FoldLanguage {
  return Object.hasOwn(FOLD_RULES, languageCode);
}

function ruleFor(languageCode: string): FoldRule {
  if (!isFoldLanguage(languageCode)) {
    throw new Error(
      `No case and fold rules for language "${languageCode}". The served languages are ` +
        `${Object.keys(FOLD_RULES).join(', ')}. Folding an unknown language as English would ` +
        'store the word under a search key nothing looks up, and nothing would report it.',
    );
  }
  return FOLD_RULES[languageCode];
}

/**
 * The true lowercase of a written form, in its own language.
 *
 * This is the DISPLAY answer, not the search key. For Turkish it maps `I` to
 * `ı` and `İ` to `i`, and it never maps `I` to `i`.
 *
 * @param value A written word form, in any case.
 * @param languageCode The language the form is read as. Must have fold rules.
 * @returns The lowercased form, with every letter still distinct.
 */
export function lowerCaseFor(value: string, languageCode: string): string {
  return value.toLocaleLowerCase(ruleFor(languageCode).caseLocale);
}

/**
 * The search key of a written form: lowercased in its own language, then folded
 * onto the letters a reader without that language's keyboard can type.
 *
 * Whitespace and punctuation are NOT this function's business. `normalizeLemma`
 * and `normalizeForLanguage` in `normalize.ts` own those, so that the shape of
 * a stored lemma is decided in one place.
 *
 * @param value A written word form, in any case and with any diacritics.
 * @param languageCode The language the form is read as. Must have fold rules.
 * @returns The folded form both the import and the query compare on.
 */
export function foldForSearch(value: string, languageCode: string): string {
  const rule = ruleFor(languageCode);
  let folded = value.toLocaleLowerCase(rule.caseLocale);
  for (const [from, to] of rule.folds) {
    folded = folded.replaceAll(from, to);
  }
  // The mark strip runs AFTER the table, and catches two things the table does
  // not: a diacritic that arrived already decomposed (`o` plus a combining
  // diaeresis rather than `ö`), and an accent on a borrowed word no language
  // lists (`café` in an English row). Re-composing afterwards keeps the output
  // in NFC, so two equal strings are also byte-equal.
  return folded.normalize('NFD').replace(COMBINING_MARKS, '').normalize('NFC');
}
