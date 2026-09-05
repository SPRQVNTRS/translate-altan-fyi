/**
 * The closed set of parts of speech this dictionary stores.
 *
 * WHY IT LIVES HERE AND NOT BESIDE THE IMPORTER THAT FIRST NEEDED IT
 *   The part of speech is one third of the headword natural key,
 *   `(language_code, lemma, pos)`. Whatever goes in that column decides whether
 *   two writers are talking about the same headword, so every writer has to draw
 *   from ONE list. It was an importer detail for exactly as long as only the
 *   Wikidata importer wrote headwords. The translation job now writes them too,
 *   from the target side, and it runs inside the web server: it cannot import
 *   `cli/commands/import/wikidata-lexemes.ts`, which pulls a dump reader and a
 *   whole command tree behind it.
 *
 *   So the values live here, with no imports at all, and both sides read them.
 *   `cli/commands/import/wikidata-lexemes.ts` derives its `POS` type from this
 *   tuple, which is what keeps the two from forking: a value added on one side
 *   is a value on the other, and there is no second list to update.
 *
 * WHY THE SET IS THIS SMALL
 *   Five buckets are few enough that every source can hit them. The reasoning,
 *   including why proper nouns fold into `noun`, is written out at
 *   `CATEGORY_BY_QID` in the Wikidata importer, which is where the mapping from
 *   an upstream vocabulary onto this list is made.
 *
 * NO IMPORTS BELONG HERE. The list is reached from the client bundle through the
 * translation answer schema, so a `.server` import, even a type-only one, would
 * break the production build.
 */

/** Every part of speech a headword row may carry. Order is display order, nothing depends on it. */
export const POS_VALUES = ['noun', 'verb', 'adjective', 'adverb', 'other'] as const;

/** One part of speech, as stored in `headwords.pos`. */
export type Pos = (typeof POS_VALUES)[number];
