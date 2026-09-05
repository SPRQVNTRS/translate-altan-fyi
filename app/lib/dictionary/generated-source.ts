/**
 * The provenance row every generated dictionary row points at.
 *
 * ONE SLUG, READ BY FOUR PLACES: the translation job that writes rows under it,
 * the attribution page that renders its card, the data migration that fills in
 * its licence and wording, and the operator CLI. A literal repeated in four
 * files would not fail when one of them was changed; it would quietly stop
 * matching, and the visible symptom would be an attribution block that renders
 * nothing while generated rows are served beside imported ones as though they
 * were imports.
 *
 * The row itself is not created here. It has existed in `sources` since the
 * first migration and is only ever updated.
 *
 * NO IMPORTS BELONG HERE. The attribution page is a client component.
 */

/** `sources.slug` of the row every generated headword, sense and translation carries. */
export const GENERATED_SOURCE_SLUG = 'llm-generated';
