/**
 * The two decisions M175/03 landed that a screenshot cannot check.
 *
 * 1. WHICH HOST REPORTS VISITS. The Matomo site id belongs to one host. A stage
 *    rehearsal and a laptop run the same production build, so if the gate were
 *    a `NODE_ENV` check every stage click would be counted as real use of the
 *    product and the numbers would stop meaning anything. There is no browser in
 *    this tier, so the gate is a pure function over the Host header and this is
 *    where it is proved.
 *
 * 2. WHAT THE LANDING PAGE SHOWS. The example under the pitch is a real row of
 *    the dictionary, fetched through the same search a visitor's own query runs.
 *    The lookup is injected, so this tier can prove the wiring (fixed word,
 *    fixed direction, one hit, and a null answer rather than a crash on an empty
 *    dictionary) without a database.
 *
 * The privacy assertion at the end is the coupling nobody else holds: the policy
 * page renders "this instance measures visits with Matomo" only because a
 * constant says so, and a tag removed without flipping it back leaves the
 * document lying in the safer direction. A test is the only thing that notices.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ANALYTICS_HOST, isAnalyticsHost } from '#app/lib/analytics-host';
import { LANDING_EXAMPLE, loadLandingExample, type LandingExampleSearch } from '#app/lib/dictionary/landing-example';
import type { SearchHeadwordsParams, SearchHit } from '#app/lib/dictionary/search.server';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));

function readAppFile(relativePath: string): string {
  return readFileSync(new URL(relativePath, `file://${REPO_ROOT}`), 'utf8');
}

describe('the analytics host gate', () => {
  it('reports visits from the production host', () => {
    assert.equal(isAnalyticsHost('kenning.altan.fyi'), true);
    assert.equal(ANALYTICS_HOST, 'kenning.altan.fyi');
  });

  it('ignores the case and the port a client happens to send', () => {
    assert.equal(isAnalyticsHost('Kenning.Altan.FYI'), true);
    assert.equal(isAnalyticsHost('kenning.altan.fyi:443'), true);
  });

  it('reads the first entry of a forwarded proxy chain', () => {
    assert.equal(isAnalyticsHost('kenning.altan.fyi, 10.0.0.4'), true);
  });

  for (const host of ['stage.kenning.altan.fyi', 'localhost:3000', 'localhost', '127.0.0.1', 'altan.fyi', '']) {
    it(`renders no tag for ${host === '' ? 'an empty host' : host}`, () => {
      assert.equal(isAnalyticsHost(host), false);
    });
  }

  it('renders no tag when there is no host header at all', () => {
    assert.equal(isAnalyticsHost(null), false);
  });

  it('is not a suffix match, which would let any subdomain in', () => {
    assert.equal(isAnalyticsHost('evil-kenning.altan.fyi'), false);
    assert.equal(isAnalyticsHost('kenning.altan.fyi.example.com'), false);
  });
});

/** One dictionary row, trimmed to the fields the landing card renders. */
const exampleHit: SearchHit = {
  headwordId: 'de-haus',
  lemma: 'Haus',
  pos: 'noun',
  languageCode: 'de',
  matchKind: 'exact',
  similarity: 1,
  gloss: null,
  translations: [
    {
      headwordId: 'en-house',
      lemma: 'house',
      languageCode: 'en',
      sourceSlug: 'wikidata',
      sourceName: 'Wikidata',
      sourceLicence: 'CC0-1.0',
    },
  ],
  examples: [],
};

/** A stand-in dictionary: what it was asked, and what it answered with. */
interface FakeSearch {
  search: LandingExampleSearch;
  calls: SearchHeadwordsParams[];
}

/** Records what the loader asked the dictionary for, then answers with `hits`. */
function fakeSearch(hits: SearchHit[]): FakeSearch {
  const calls: SearchHeadwordsParams[] = [];
  const search: LandingExampleSearch = (params) => {
    calls.push(params);
    return Promise.resolve(hits);
  };
  return { search, calls };
}

describe('the landing example', () => {
  it('returns the fixed example entry, ready to render', async () => {
    const { search } = fakeSearch([exampleHit]);

    const example = await loadLandingExample(search);

    assert.deepEqual(example, { word: 'Haus', from: 'de', to: 'en', hit: exampleHit });
  });

  it('looks the example up in the dictionary, in one fixed direction', async () => {
    const { search, calls } = fakeSearch([exampleHit]);

    await loadLandingExample(search);

    assert.deepEqual(calls, [{ q: 'Haus', from: 'de', to: 'en', limit: 1 }]);
    assert.equal(LANDING_EXAMPLE.word, 'Haus');
  });

  it('answers null rather than throwing when the dictionary has no such row', async () => {
    const { search } = fakeSearch([]);

    assert.equal(await loadLandingExample(search), null);
  });
});

describe('the privacy policy and the tag agree', () => {
  const root = readAppFile('app/root.tsx');
  const privacy = readAppFile('app/routes/legal/privacy.tsx');
  const matomo = readAppFile('app/components/site/matomo.tsx');

  it('renders the tag from the root document, gated on the host', () => {
    assert.match(root, /isAnalyticsEnabled && <Matomo \/>/);
    assert.match(matomo, /setSiteId', '19'/);
  });

  it('never lets the tracker see the query string, which carries the search', () => {
    // The privacy page states Matomo is never told what was searched for, and a
    // results page is `/?q=<word>`. Reporting `location.href` would file every
    // lookup in the analytics database.
    assert.match(matomo, /setCustomUrl.*location\.pathname/);
    assert.doesNotMatch(matomo, /location\.href/);
  });

  it('says so on the privacy page, because the tag exists', () => {
    assert.match(privacy, /const ANALYTICS_ENABLED = true;/);
    assert.match(privacy, /s11BodyMatomo/);
  });
});
