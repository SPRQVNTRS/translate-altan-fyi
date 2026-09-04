/**
 * A signed-out visitor at `/` gets the landing page, carrying a REAL worked
 * example (M184 spec 03).
 *
 * WHY THIS CASE IS THE FIRST ONE IN THE MILESTONE
 *   Everything else here closes a door. This one holds a door open. The gate
 *   added to `translate.tsx`'s loader is one line away from swallowing the landing
 *   page as well, and the failure would be silent in the worst way: a stranger
 *   following a link to translate.altan.fyi would be bounced to a sign-in form
 *   for an account they cannot create, and nothing in a typecheck, a lint or a
 *   build would notice.
 *
 * IT ASSERTS THE CONTENT, NOT THE STATUS
 *   A status is not the claim. The loader returning at all is what a 200 means
 *   here, since a refusal on this path is a thrown redirect `Response`, and
 *   `assert.doesNotReject` would already cover that. What a status cannot show
 *   is whether the page has anything ON it, and the landing pitch's whole
 *   argument is the worked example: a real row of the real dictionary, looked
 *   up through the same function a visitor's own search uses. So the assertions
 *   below are about the example: the right word, a gloss, and at least one
 *   translation. An empty shell fails.
 *
 * NO ROW IS CREATED, READ DESTRUCTIVELY, OR DELETED
 *   This case only reads. `Haus` is the fixed landing example and it is part of
 *   the seeded dictionary; if it is missing, that is a broken import and this
 *   case is right to be red about it.
 *
 * THE PRECONDITION IS A REACHABLE DATABASE. `DB_HOST`, nothing else: no API key
 * and no server on :3456. `tests/unit/integration-tests-self-skip.test.ts`
 * counts the guard against the case one for one.
 */
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { RouterContextProvider } from 'react-router';

import { closePool, poolInitialized } from '../../drizzle/db';
import { LANDING_EXAMPLE } from '../../app/lib/dictionary/landing-example';
import { loader as translateLoader } from '../../app/routes/translate';

const DB_HOST = process.env.DB_HOST;

/**
 * The index route, with no query and no cookie: a first-time stranger.
 *
 * The extra members of the loader's argument are the ones the router supplies
 * and this route reads none of. They are passed so the call is the shape the
 * framework makes rather than a narrower one invented here.
 */
async function loadLandingAnonymously() {
  const request = new Request('https://translate.altan.fyi/');
  return translateLoader({
    request,
    url: new URL(request.url),
    params: {},
    pattern: '/',
    context: new RouterContextProvider(),
  });
}

after(async () => {
  // THE POOL FINISHES OPENING BEFORE IT IS CLOSED. `drizzle/db.ts` kicks off
  // `ensureHostIndexes` behind `poolInitialized` at import time, and a short
  // test file can reach `closePool()` first, which turns a passing run into
  // "Cannot use a pool after calling end on the pool" reported as a failure.
  await poolInitialized;
  await closePool();
});

describe('the anonymous landing page', () => {
  it(
    'answers with the landing pitch and a real worked example',
    { skip: !DB_HOST ? 'DB_HOST not set' : false },
    async () => {
      const data = await loadLandingAnonymously();

      // The landing branch, identified by what it returns rather than by what
      // it was asked: no query, no hits, no phrase, and no enrichment panel,
      // which together are the only shape that costs no provider call.
      assert.equal(data.q, '', 'a request with no query did not take the landing branch');
      assert.equal(data.panel, null, 'the landing page carried an enrichment panel, which would be spend');
      assert.deepEqual(data.hits, []);

      const example = data.example;
      assert.ok(
        example !== null,
        `The landing page has no worked example. The fixed example word is '${LANDING_EXAMPLE.word}' and the ` +
          'dictionary answered nothing for it, so either the import is broken or the landing query is. The ' +
          'page renders its copy without the card in that state, which is exactly the empty shell this case exists to catch.',
      );

      assert.equal(example.word, LANDING_EXAMPLE.word);
      assert.equal(example.hit.lemma, LANDING_EXAMPLE.word, 'the example card is for a different word');
      assert.ok((example.hit.gloss ?? '').length > 0, 'the example card carries no gloss, so it explains nothing');
      assert.ok(
        example.hit.translations.length > 0,
        'the example card carries no translation, so it demonstrates nothing a translator wants',
      );
    },
  );
});
