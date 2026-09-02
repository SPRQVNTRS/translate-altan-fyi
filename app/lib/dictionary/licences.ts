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
 * WHY THESE FOUR AND NOTHING ELSE
 *   CC0-1.0        Public domain dedication. No obligation attaches to reuse.
 *   CC-BY-2.0-FR   Attribution only. We publish the attribution the source
 *                  requires, which the `sources.attribution` column holds.
 *   CC-BY-4.0      Attribution only, same handling.
 *   LLM-GENERATED  Our own enrichment output. We own it, so no upstream
 *                  licence constrains it. It is marked as its own licence so
 *                  that generated content is always distinguishable from
 *                  imported content.
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
export const SERVED_LICENCES = ['CC0-1.0', 'CC-BY-2.0-FR', 'CC-BY-4.0', 'LLM-GENERATED'] as const;

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
