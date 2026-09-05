/**
 * The licence allowlist: which dictionary rows may be SERVED.
 *
 * WHAT THIS LIST MEANS
 *   Every content row in the shared dictionary carries a NOT NULL `sourceId`,
 *   and every source carries an SPDX-style `licence` string. A row may only
 *   leave this system, on a page, in an API response, in an export, if its
 *   source licence appears in `SERVED_LICENCES` below. A row whose licence is
 *   absent from this list may be stored and counted, but never served.
 *
 * WHY THESE THREE AND NOTHING ELSE
 *   CC0-1.0        Public domain dedication. No obligation attaches to reuse.
 *   CC-BY-2.0-FR   Attribution only. We publish the attribution the source
 *                  requires, which the `sources.attribution` column holds.
 *   CC-BY-4.0      Attribution only, same handling.
 *
 * WHY THE GENERATED-CONTENT IDENTIFIER IS NO LONGER ON THE LIST
 *   A fourth entry used to sit here: our own output's own licence identifier, on
 *   the reasoning that generated content should be distinguishable from imported
 *   content by its licence. `tests/unit/dictionary-licences.test.ts` names it,
 *   and is the only place that still does. The operator decision of 2026-09-05
 *   released generated entries under CC0-1.0 like the imported data, so the one
 *   row that carried it now reads `CC0-1.0` and no row anywhere carries the old
 *   value. Leaving a dead identifier on an allowlist is not harmless: this list
 *   is read as the set of licences the product is prepared to serve, and an
 *   entry no row uses invites the next reader to attach a row to it.
 *
 *   Generated content is still distinguishable, and by something stronger than a
 *   licence string: every generated row points at the source row whose slug is
 *   `llm-generated`, which is what the attribution page and the generated marker
 *   in the app both key on.
 *
 * WHAT IS DELIBERATELY EXCLUDED, AND WHY
 *   Share-alike and copyleft sources are excluded by operator decision, because
 *   serving them would place a share-alike or copyleft obligation on the
 *   surrounding product. The excluded sources are:
 *
 *     Kaikki / Wiktextract  (Wiktionary derived, CC BY-SA)
 *     WikDict               (Wiktionary derived, CC BY-SA)
 *     ding                  (GPL)
 *     Apertium              (GPL)
 *     IPA-dict, German rows (the DE portion is licensed more restrictively
 *                            than the rest of that dataset)
 *
 *   These may still be imported and stored for internal comparison. They must
 *   not reach a reader.
 *
 * CHANGING THIS LIST IS A LEGAL DECISION, NOT A REFACTOR
 *   Adding an entry here makes every row of that licence publicly served, in
 *   every surface, immediately. Do not add one to make a query return more
 *   rows, to make a test pass, or to unblock an import. Adding an entry
 *   requires the operator's explicit decision, recorded outside this file.
 *   `tests/unit/dictionary-licences.test.ts` is the tripwire on that decision:
 *   it fails on any change to this list, on purpose.
 */

/** The only licences whose rows may be served. See the file comment before editing. */
export const SERVED_LICENCES = ['CC0-1.0', 'CC-BY-2.0-FR', 'CC-BY-4.0'] as const;

/** A licence identifier that is cleared for serving. */
export type ServedLicence = (typeof SERVED_LICENCES)[number];

/**
 * Narrow an arbitrary licence string to a served one.
 *
 * This is the in-memory counterpart of the SQL predicate in
 * `queries.server.ts`. It exists for rows that arrive from somewhere other than
 * a licence-filtered query, an import script deciding whether to publish, for
 * example. It is NOT a substitute for the SQL filter: filtering query results
 * in JavaScript leaks rows through any code path that forgets to call this.
 */
export function isServedLicence(licence: string): licence is ServedLicence {
  return SERVED_LICENCES.some((served) => served === licence);
}
