/**
 * A signed-out `GET /search?q=Haus` is sent to the sign-in page too (M184
 * spec 03).
 *
 * WHY THIS FILE EXISTS BESIDE `anonymous-index-query-redirects.test.ts`
 *   `/` and `/search` are two route ids over ONE module. The rule that gates
 *   them lives in the single loader they share, keyed on the request rather
 *   than on the path, and this file is the evidence that the sharing is real:
 *   one check, both URLs, with nothing written twice. The pair matters more
 *   than either half. A path-keyed rule can make either one of these files
 *   green on its own, and the first draft of this milestone did exactly that,
 *   gating this alias while `/?q=` stayed open.
 *
 *   If this case ever goes red while its sibling stays green, the gate has been
 *   moved out of the shared loader and onto one of the two ids. Put it back
 *   rather than adding a second check here.
 *
 * ISOLATION
 *   The account and the invite the second case creates are deleted in
 *   `after()`, by id. `Haus` is read, never written.
 *
 * THE PRECONDITION IS A REACHABLE DATABASE. `DB_HOST`, nothing else.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { RouterContextProvider } from 'react-router';

import { closePool, poolInitialized } from '../../drizzle/db';
import { SIGN_IN_PATH } from '../../app/lib/auth/paths';
import { loader as searchLoader } from '../../app/routes/search';
import { createTestUserSession, type TestUserSession } from '../fixtures/user-session';

const DB_HOST = process.env.DB_HOST;

/** The word searched. A seeded dictionary entry, so a signed-in run has something to answer with. */
const WORD = 'Haus';

let session: TestUserSession | null = null;

/** `GET /search?q=Haus`, on the `search-alias` route id's own pattern. */
async function loadAliasQuery(cookie: string | null) {
  const request = new Request(`https://translate.altan.fyi/search?q=${WORD}&from=de&to=en`, {
    headers: cookie === null ? {} : { cookie },
  });
  return searchLoader({
    request,
    url: new URL(request.url),
    params: {},
    pattern: '/search',
    context: new RouterContextProvider(),
  });
}

before(async () => {
  if (!DB_HOST) return;
  session = await createTestUserSession('alias-query');
});

after(async () => {
  if (session !== null) await session.dispose();
  // THE POOL FINISHES OPENING BEFORE IT IS CLOSED. `drizzle/db.ts` kicks off
  // `ensureHostIndexes` behind `poolInitialized` at import time, and a short
  // test file can reach `closePool()` first, which turns a passing run into
  // "Cannot use a pool after calling end on the pool" reported as a failure.
  await poolInitialized;
  await closePool();
});

describe('an anonymous query on the /search alias', () => {
  it('redirects to the sign-in page', { skip: !DB_HOST ? 'DB_HOST not set' : false }, async () => {
    const thrown = await loadAliasQuery(null).then(
      () => null,
      (cause: unknown) => cause,
    );

    assert.ok(
      thrown instanceof Response,
      'GET /search?q= answered a signed-out visitor with data. Both route ids run one loader, so this and the ' +
        'index case must always agree: if only one of them is red, the rule has been moved onto a path.',
    );
    assert.equal(thrown.status, 302);
    // THE PATH, NOT THE WHOLE HEADER. The gate carries `?next=` since M191 so
    // the reader lands back where they were refused, and an assertion on the
    // full string would read as a broken gate the first time that changed.
    assert.equal(new URL(thrown.headers.get('location') ?? '', 'https://translate.altan.fyi').pathname, SIGN_IN_PATH);
  });

  it('answers the same URL with results once signed in', { skip: !DB_HOST ? 'DB_HOST not set' : false }, async () => {
    assert.ok(session !== null, 'the fixture account was not created, so this case would prove nothing');

    const data = await loadAliasQuery(session.cookie);

    assert.equal(data.q, WORD);
    assert.ok(data.hits.length > 0, `the signed-in search for '${WORD}' returned no hits, so the refusal above is not evidence of a gate`);
  });
});
