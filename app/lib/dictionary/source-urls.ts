/**
 * The two pure, client-safe display seams over a source row: the deep link back
 * to the individual record, and the licence label shown in the credit.
 *
 * WHY THE LABEL IS HERE AND NOT IN `licences.ts`
 *   `licences.ts` is a legal tripwire. `SERVED_LICENCES` is an operator
 *   decision, and the repository treats ANY modification of that file as one,
 *   which is the whole point of `tests/unit/dictionary-licences.test.ts`. How a
 *   licence is spelled on screen is a display choice, not a licence decision, so
 *   putting it there would make a cosmetic change show up as a change to the
 *   allowlist. This module imports from `licences.ts` and never writes to it.
 *
 * WHY THIS IS NOT A `.server` MODULE
 *   The credit under an example sentence is rendered by a component, so the
 *   link it points at has to be computable in the browser. This module holds no
 *   database handle, reads no environment, and imports nothing but types, which
 *   is what lets a component call it.
 *
 * WHY ONLY TATOEBA IS ADDRESSABLE
 *   An external id is only a link when the source publishes a stable per-record
 *   URL and we know how to build it. Tatoeba does. Wikidata lexemes reach us as
 *   headwords rather than as examples, and our own LLM output has no upstream
 *   record at all. Every other slug therefore returns `null`, and the caller
 *   renders the credit without a link rather than a plausible-looking URL that
 *   404s.
 */

import { isServedLicence, type ServedLicence } from './licences';

/** The Tatoeba sentence page. One constant, because two copies drift. */
export const TATOEBA_SENTENCE_BASE_URL = 'https://tatoeba.org/en/sentences/show/';

/**
 * The slugs whose external ids we can turn into a URL.
 *
 * Tatoeba arrives under two slugs because the importer splits the corpus by
 * licence: the CC BY 2.0 FR sentences and the CC0 ones are separate sources
 * with separate attribution, and both address the same sentence pages.
 */
const TATOEBA_SLUGS = new Set(['tatoeba', 'tatoeba-cc0']);

/**
 * A deep link to the individual record at the source, when the slug is one we
 * can address.
 *
 * THE ID IS A PAIR, THE URL TAKES THE FIRST HALF.
 *   The Tatoeba importer writes `external_id` as `<sentenceId>:<translationId>`
 *   (see `cli/commands/import/tatoeba.ts`), because the sentence and its
 *   translation together are what makes the row unique. The page it links to is
 *   the SENTENCE page, so only the first segment addresses anything.
 *
 *   A segment that is not a run of digits is not a sentence id, and a URL built
 *   from it would be a broken link on a public page. So the shape is checked
 *   rather than assumed, and anything else returns `null`.
 */
export function sourceRecordUrl(sourceSlug: string, externalId: string | null): string | null {
  if (!TATOEBA_SLUGS.has(sourceSlug)) return null;
  if (externalId === null || externalId === '') return null;
  const [sentenceId] = externalId.split(':');
  if (sentenceId === undefined || sentenceId === '') return null;
  if (!/^\d+$/.test(sentenceId)) return null;
  return `${TATOEBA_SENTENCE_BASE_URL}${sentenceId}`;
}

/**
 * How a licence is WRITTEN when it is shown to a reader.
 *
 * These are names, not copy. "CC BY 4.0" is the same string in every interface
 * language, so it does not belong in the locale catalogs: a translator given
 * this string has nothing to translate and every chance to corrupt it. The
 * surrounding sentence is the translated part, and that lives in the catalogs.
 *
 * The map is checked with `satisfies` rather than annotated, so adding a licence
 * to `SERVED_LICENCES` without giving it a label is a type error rather than a
 * blank on a page, and the labels themselves keep their literal types.
 */
export const LICENCE_LABELS = {
  'CC0-1.0': 'CC0',
  'CC-BY-2.0-FR': 'CC BY 2.0 FR',
  'CC-BY-4.0': 'CC BY 4.0',
} satisfies Record<ServedLicence, string>;

/**
 * The display label for a licence identifier.
 *
 * An unserved licence falls back to its raw identifier rather than to a blank
 * or to a guess. A row of such a licence must never reach a page at all, so if
 * one does, the screen should say exactly which licence it was.
 */
export function licenceLabel(licence: string): string {
  if (!isServedLicence(licence)) return licence;
  return LICENCE_LABELS[licence];
}
