import type { LanguageCode } from '#app/lib/dictionary/detect-language';
import type { SearchHeadwordsParams, SearchHit } from '#app/lib/dictionary/search.server';

/**
 * The one worked example the landing section shows.
 *
 * A REAL RESULT, NOT A MOCKUP. The example is loaded from the same dictionary a
 * visitor's own first search hits, through the same query function and rendered
 * by the same result component. A screenshot or a hand-written card would keep
 * looking correct on the day the dictionary stopped answering, which is exactly
 * the day the landing page must stop claiming it works.
 *
 * The word is fixed rather than random so the page is cacheable, comparable
 * between deploys and identical in a bug report. `Haus` is a common German noun
 * with translations and recorded sentences, so the card shows the whole shape of
 * a result rather than a lonely lemma.
 */
export const LANDING_EXAMPLE = {
  word: 'Haus',
  from: 'de',
  to: 'en',
} as const satisfies { word: string; from: LanguageCode; to: LanguageCode };

/** The example result, ready to render, or nothing when the dictionary has no answer. */
export interface LandingExample {
  /** The headword that was looked up, for the heading above the card. */
  word: string;
  /** The language the example is looked up in. */
  from: LanguageCode;
  /** The language it is translated into, carried into the entry link. */
  to: LanguageCode;
  /** The result itself, the same shape a real search produces. */
  hit: SearchHit;
}

/**
 * The dictionary lookup, injected.
 *
 * The route closes over its database handle and passes it in, which keeps this
 * module free of `.server` code and testable without a database.
 */
export type LandingExampleSearch = (params: SearchHeadwordsParams) => Promise<SearchHit[]>;

/**
 * Loads the landing page's worked example.
 *
 * @param search The dictionary search, already bound to a database handle.
 * @returns The first hit for the fixed example word, or null when there is none.
 */
export async function loadLandingExample(search: LandingExampleSearch): Promise<LandingExample | null> {
  const hits = await search({
    q: LANDING_EXAMPLE.word,
    from: LANDING_EXAMPLE.from,
    to: LANDING_EXAMPLE.to,
    // One card. The landing section is a demonstration, not a results page.
    limit: 1,
  });
  const hit = hits[0];
  // A dictionary with no entry for the example word is a broken import, not a
  // reason to fail the home page. The section renders its copy without the card.
  if (hit === undefined) return null;

  return { word: LANDING_EXAMPLE.word, from: LANDING_EXAMPLE.from, to: LANDING_EXAMPLE.to, hit };
}
