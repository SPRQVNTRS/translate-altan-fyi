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

/**
 * THE GENERATED SOURCE IS FOUND BY ITS SLUG, NOT BY ITS LICENCE.
 *
 * It used to be found by `licence === 'LLM-GENERATED'`, and that broke the
 * moment the row's licence became `CC0-1.0`: the check matched nothing, the
 * attribution block stopped rendering, and the generated source fell in
 * beside Wikidata as though it were an import. A licence is a property this
 * row shares with other rows; the slug is its identity, and it is the same
 * value every generated dictionary row attributes to, whatever its licence
 * string says.
 */
export function isGeneratedSource(source: { slug: string }): boolean {
  return source.slug === GENERATED_SOURCE_SLUG;
}
