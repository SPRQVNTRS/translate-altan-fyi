/**
 * Re-export only. The canonical home of the normalizers is
 * `app/lib/dictionary/normalize.ts`.
 *
 * WHY IT MOVED
 *   The search path normalizes a user's query with the same function that wrote
 *   `headwords.lemma_normalized` on import, and the two are compared with a
 *   plain `=`. Two copies would not fail loudly; they would silently stop
 *   finding rows wherever they disagreed. One definition, imported by both
 *   sides, is the only shape in which the importer and the search cannot drift
 *   apart.
 *
 *   This file stays so the importers keep their local import path, and so
 *   `tests/unit/importer-normalize.test.ts` keeps testing the function the
 *   importers actually call. `tests/unit/locale-fold.test.ts` goes one step
 *   further and asserts that what arrives HERE and what arrives at the search
 *   path are the same function, so this re-export cannot quietly fork.
 *
 * WHICH ONE TO CALL
 *   `normalizeForLanguage` and `tokenizeForLanguage` on every write and every
 *   lookup. `normalizeLemma` only where the language is genuinely unknown,
 *   which today is language detection alone.
 */
export {
  normalizeLemma,
  normalizeForLanguage,
  tokenizeForLanguage,
} from '#app/lib/dictionary/normalize';
