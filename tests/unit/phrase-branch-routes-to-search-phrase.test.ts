/**
 * A multi-word query must reach `searchPhrase`, and must never reach
 * `searchHeadwords` as one long lemma.
 *
 * WHY THIS TEST EXISTS NOW. The box on `/` is a `<textarea>`, so multi-word
 * input is the ordinary case rather than the rare one it was behind a one-line
 * field. That makes `translate.tsx`'s phrase branch the MAIN path, and a
 * regression in it would not look like a crash: the single-word path answers a
 * whole sentence by folding it into one string, comparing that string against
 * `headwords.lemma_normalized`, finding nothing, and then handing back whichever
 * single word shares the most three-letter runs with the sentence. That is a
 * confident wrong answer, which is the failure mode a result-shaped assertion
 * on a live database would also be happy with.
 *
 * WHAT IT ASSERTS, AND WHY IN TWO REGISTERS.
 *   1. The DECISION is executed. `normalizeQuery(...).isPhrase` is the real
 *      predicate the route branches on, called here with translator-shaped
 *      input: a typed sentence, a pasted paragraph, a two word phrase, and the
 *      single words that must still go the other way.
 *   2. The GUARD is executed. `searchPhrase` refuses a single word, so the two
 *      paths are not interchangeable and the route cannot answer both from one
 *      of them.
 *   3. The WIRING is read as source. Which function a loader calls in which
 *      branch is a structural property with no return value to assert on, and
 *      running the loader would need a database, a request and a language
 *      detection round trip to observe something the source states plainly.
 *      `voice-input-textarea-submit.test.ts` reads the same file for the same
 *      reason.
 *
 * NO DATABASE IS TOUCHED. The handle points at a port nothing listens on, so a
 * call that reached the database would fail loudly rather than pass quietly.
 * `searchPhrase`'s guard throws before it uses the handle at all, which is the
 * property case 2 is about.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from '../../drizzle/schema';
import { normalizeQuery } from '../../app/lib/dictionary/normalize';
import { searchPhrase } from '../../app/lib/dictionary/search.server';

/** Deliberately unreachable: nothing here may complete a query. */
const UNREACHABLE_DSN = 'postgres://user:pass@127.0.0.1:1/none';

const db = drizzle(new pg.Pool({ connectionString: UNREACHABLE_DSN }), { schema });

/** The route as text. Read once, questioned three times. */
const ROUTE_SOURCE = readFileSync(new URL('../../app/routes/translate.tsx', import.meta.url), 'utf8');

/** What a translator actually puts in a text area. */
const PHRASES = [
  'guten Tag',
  'Ich habe den Zug verpasst',
  'Der Termin wurde verschoben, weil der Kollege krank geworden ist.',
];

/** What must still take the single-word path, punctuation and all. */
const SINGLE_WORDS = ['Haus', '"Feierabend"', 'Straße?'];

/**
 * The body of the loader's phrase branch, and where it sits in the file.
 *
 * The return type is inferred rather than annotated: an anonymous object type
 * written out here would widen `match.index` and friends for no reader's
 * benefit, which the lint gate refuses.
 *
 * The condition is matched by shape rather than by the variable's name, so
 * renaming the normalized query does not fail this test for the wrong reason.
 */
function phraseBranch() {
  const match = /if \(\w+\.isPhrase\) \{([\s\S]*?)\n {2}\}/.exec(ROUTE_SOURCE);
  assert.ok(
    match,
    'translate.tsx has no `if (<query>.isPhrase) { ... }` branch in its loader. Without it a ' +
      'typed sentence goes to searchHeadwords, which answers it with the single word that ' +
      'happens to share the most trigrams.',
  );
  return {
    body: match[1] ?? '',
    start: match.index,
    end: match.index + match[0].length,
  };
}

describe('the branch decision, executed', () => {
  for (const phrase of PHRASES) {
    it(`reads ${JSON.stringify(phrase.slice(0, 24))} as a phrase`, () => {
      assert.equal(normalizeQuery(phrase, 'de').isPhrase, true);
    });
  }

  for (const word of SINGLE_WORDS) {
    it(`reads ${JSON.stringify(word)} as a single word`, () => {
      assert.equal(normalizeQuery(word, 'de').isPhrase, false);
    });
  }

  it('counts the words of a pasted paragraph rather than its lines', () => {
    const pasted = 'Sehr geehrte Damen und Herren,\n\nvielen Dank für Ihre Nachricht.';
    const query = normalizeQuery(pasted, 'de');
    assert.equal(query.isPhrase, true);
    assert.equal(query.tokens.length, 10);
  });
});

describe('the two paths are not interchangeable', () => {
  it('searchPhrase refuses a single word, before it touches the database', async () => {
    await assert.rejects(
      () => searchPhrase(db, { q: 'Haus', from: 'de', to: 'en' }),
      /single word/,
      'searchPhrase accepted a single word. Its guard is what makes the route`s branch ' +
        'mandatory rather than an optimisation.',
    );
  });
});

describe('the route wires the phrase branch to searchPhrase', () => {
  it('branches on the normalized query, not on a second word-count of its own', () => {
    assert.match(
      ROUTE_SOURCE,
      /normalizeQuery\(q, direction\.from\)/,
      'the loader no longer derives its branch from normalizeQuery, so the route and ' +
        'searchPhrase can disagree about what counts as a phrase.',
    );
  });

  it('calls searchPhrase inside that branch and searchHeadwords nowhere in it', () => {
    const { body } = phraseBranch();
    assert.match(body, /searchPhrase\(/, 'the phrase branch does not call searchPhrase.');
    assert.doesNotMatch(
      body,
      /searchHeadwords\(/,
      'the phrase branch calls searchHeadwords, which cannot answer a phrase.',
    );
    assert.match(body, /return /, 'the phrase branch does not return, so a phrase falls through.');
  });

  it('leaves the single-word lookup unreachable for a phrase', () => {
    const { end } = phraseBranch();
    const lookup = ROUTE_SOURCE.indexOf('const hits = await searchHeadwords(');
    assert.ok(lookup > -1, 'the single-word lookup is gone from the loader.');
    assert.ok(
      lookup > end,
      'the unconditional searchHeadwords call sits before the phrase branch closes, so a ' +
        'phrase is looked up as one long lemma on its way to searchPhrase.',
    );
  });

  // WHAT THE SECOND HALF OF THIS CASE NAMES, AND WHY IT WAS REWORDED IN M185/03.
  //   The warm used to be a bare `enqueueEnrichmentInBackground(` call in this
  //   route, and this case matched that literal. The output pane now RENDERS the
  //   top hit's panel, so the route calls `resolveTriggeredPanel` instead: the
  //   shared state machine in `#app/lib/enrichment/trigger.server` that
  //   `entry.$headwordId.tsx` also calls, which reads the cache, runs the spend
  //   guards, and enqueues behind the response exactly as before. The warm is
  //   therefore still here and still fire and forget; only the seam moved. The
  //   old literal would now be red on success, so the check names the new seam
  //   rather than the code being reverted to satisfy it.
  it('keeps the single-word top-hit warm out of the phrase branch', () => {
    const { body } = phraseBranch();
    assert.doesNotMatch(
      body,
      /enqueueEnrichmentInBackground|resolveTriggeredPanel/,
      'the phrase branch starts enrichment. Phrase-first is the main path now, so warming ' +
        'per word here multiplies provider spend by the length of whatever was pasted.',
    );
    assert.match(
      ROUTE_SOURCE,
      /resolveTriggeredPanel\(/,
      'the single-word top-hit warm is gone. The relayout was not meant to remove it: it is ' +
        'the shared trigger the entry page also runs, and it still enqueues behind the response.',
    );
  });
});
