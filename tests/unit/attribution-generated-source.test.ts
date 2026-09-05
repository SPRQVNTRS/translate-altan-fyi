/**
 * The attribution page must find the generated source by its SLUG, never by
 * its licence string. See app/lib/dictionary/generated-source.ts and the
 * requirement in .tracker/M193-trl-llm-translations-on-demand/
 * 01-the-job-the-corpus-rows-and-their-provenance.md.
 *
 * Pure logic, no DOM and no database: `isGeneratedSource` is the whole
 * decision the attribution page's card rendering depends on.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { GENERATED_SOURCE_SLUG, isGeneratedSource } from '#app/lib/dictionary/generated-source';

describe('isGeneratedSource', () => {
  it('classifies the llm-generated row as generated, with the CC0 licence it now carries', () => {
    assert.equal(isGeneratedSource({ slug: GENERATED_SOURCE_SLUG }), true);
  });

  it('does not classify a Wikidata row as generated merely because it also carries CC0-1.0', () => {
    // The bug this guards against: the old check matched on
    // `licence === 'LLM-GENERATED'`, so any other row sharing a licence
    // string with the generated row would have been misclassified the
    // moment that check was inverted.
    assert.equal(isGeneratedSource({ slug: 'wikidata' }), false);
  });

  it('classifies the llm-generated row as generated whatever its licence string says', () => {
    // The slug is the identity; a licence field on the row, of any value,
    // never enters the decision.
    const row = { slug: GENERATED_SOURCE_SLUG, licence: 'CC-BY-4.0' };
    assert.equal(isGeneratedSource(row), true);
  });
});
