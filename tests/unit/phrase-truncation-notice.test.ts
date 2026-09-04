/**
 * A partly read query must not render as a whole answer.
 *
 * THE DEFECT THE TRANSLATOR LAYOUT CREATED. `searchPhrase` looks up at most
 * `PHRASE_TOKEN_LIMIT` words of a phrase, and everything past that is dropped
 * with no trace in the result. Behind a one-line search box that cap was
 * unreachable in practice: nobody typed a paragraph into it. A text area
 * invites a pasted sentence or a whole paragraph, so the cap is now ordinary,
 * and the pane would answer the first few words of a long paste with the
 * confident shape of a complete answer.
 *
 * WHAT THE FIX IS. The loader reports how many words were typed but not looked
 * up, and the output pane says so when that number is above zero. The number is
 * computed from what the search ACTUALLY looked at, `query.tokens.length -
 * phrase.tokens.length`, rather than from the constant, so it stays true if the
 * cap ever moves.
 *
 * WHY THE WIRING IS READ AS SOURCE. Executing the loader needs a database and a
 * request, and executing `searchPhrase` needs the same database, so neither can
 * demonstrate here that the pane is told. The arithmetic itself is executed
 * against the real cap below; the two source cases pin the two ends of the wire
 * that carries it to the reader.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { normalizeQuery } from '../../app/lib/dictionary/normalize';
import { PHRASE_TOKEN_LIMIT } from '../../app/lib/dictionary/search.server';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));

const ROUTE_SOURCE = readFileSync(join(REPO_ROOT, 'app/routes/translate.tsx'), 'utf8');
/**
 * The surface, as text, and it is a SECOND file since M186.
 *
 * The translator markup moved out of the route into `SearchPanes`, so the route
 * still owns the arithmetic and the component now owns the notice. Reading only
 * the route would have made the surface cases pass on a file that no longer
 * renders the surface. The questions are unchanged, only the file each one is
 * asked of.
 */
const PANES_SOURCE = readFileSync(join(REPO_ROOT, 'app/components/search-panes.tsx'), 'utf8');
const SEARCH_SOURCE = readFileSync(join(REPO_ROOT, 'app/lib/dictionary/search.server.ts'), 'utf8');

/** The i18n key the pane renders when the query was read only in part. */
const NOTICE_KEY = 'phraseTruncatedNote';

/** The one placeholder that key carries: how many words were looked up. */
const NOTICE_PLACEHOLDER = '{{lookedUp}}';

/** How many words past the cap the sample paste carries. */
const OVERFLOW = 3;

/** The `search` section of one locale's `common.json`, decoded rather than inspected. */
const SearchSectionSchema = z.object({ search: z.record(z.string(), z.string()) });

function searchStrings(locale: string): Record<string, string> {
  const raw = readFileSync(join(REPO_ROOT, 'app/locales', locale, 'common.json'), 'utf8');
  return SearchSectionSchema.parse(JSON.parse(raw)).search;
}

describe('the cap is reachable from a text area, and the shortfall is countable', () => {
  it('drops every word past the cap out of the lookup', () => {
    const pasted = Array.from({ length: PHRASE_TOKEN_LIMIT + OVERFLOW }, (_, index) => `wort${index}`).join(' ');
    const query = normalizeQuery(pasted, 'de');
    const lookedUp = query.tokens.slice(0, PHRASE_TOKEN_LIMIT);

    assert.equal(query.isPhrase, true);
    assert.equal(query.tokens.length - lookedUp.length, OVERFLOW);
  });

  it('leaves nothing to say for a phrase that fits', () => {
    const short = Array.from({ length: PHRASE_TOKEN_LIMIT }, (_, index) => `wort${index}`).join(' ');
    const query = normalizeQuery(short, 'de');
    assert.equal(query.tokens.length - query.tokens.slice(0, PHRASE_TOKEN_LIMIT).length, 0);
  });

  it('caps the lookup with the named constant, not an inlined number', () => {
    assert.match(
      SEARCH_SOURCE,
      /slice\(0, PHRASE_TOKEN_LIMIT\)/,
      'searchPhrase no longer truncates through PHRASE_TOKEN_LIMIT, so the route`s count of ' +
        'omitted words may no longer describe what the search skipped.',
    );
  });
});

describe('the shortfall reaches the reader', () => {
  it('the loader counts typed words against looked-up words', () => {
    assert.match(
      ROUTE_SOURCE,
      /phraseWordsOmitted = \w+\.tokens\.length - phrase\.tokens\.length/,
      'the loader no longer derives the omitted count from what searchPhrase looked at. A ' +
        'count taken from the constant instead goes wrong the day the constant moves.',
    );
  });

  it('the output pane renders the notice, and only when something was omitted', () => {
    assert.match(
      PANES_SOURCE,
      /phraseWordsOmitted > 0/,
      'nothing in the route gates on the omitted count, so either the notice never shows or ' +
        'it shows on every phrase.',
    );
    assert.match(
      PANES_SOURCE,
      new RegExp(`t\\('search\\.${NOTICE_KEY}'`),
      'the pane does not render the truncation notice, so a paragraph is answered in part ' +
        'and presented in full.',
    );
  });

  it('never hardcodes the sentence in the route', () => {
    assert.doesNotMatch(
      ROUTE_SOURCE + PANES_SOURCE,
      /Only the first/,
      'the notice is written in English in the route rather than in the locale catalogs, so ' +
        'a German reader gets an English warning.',
    );
  });
});

describe('every locale carries the notice', () => {
  const locales = readdirSync(join(REPO_ROOT, 'app/locales'), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);

  it('finds locale directories to check at all', () => {
    assert.ok(locales.length > 0, 'app/locales holds no locale directories.');
  });

  for (const locale of locales) {
    it(`${locale} has the key, with its placeholder`, () => {
      const strings = searchStrings(locale);
      const value = strings[NOTICE_KEY];
      assert.ok(value, `app/locales/${locale}/common.json has no search.${NOTICE_KEY}.`);
      assert.ok(
        value.includes(NOTICE_PLACEHOLDER),
        `search.${NOTICE_KEY} in ${locale} lost ${NOTICE_PLACEHOLDER}, so the notice cannot ` +
          'say how many words were looked up.',
      );
    });
  }
});
