/**
 * A signed-out `GET /?q=Haus` is sent to the sign-in page (M184 spec 03).
 *
 * WHY THE INDEX AND NOT `/translate`
 *   `/?q=<word>` is the PRIMARY search URL of this product, confirmed live at
 *   `https://translate.altan.fyi/?q=Kummerspeck&from=en&to=de`. `/translate` is
 *   the alias, and `app/routes.ts` names it `translate-alias` in as many words.
 *   The first draft of this milestone gated the alias and left this URL open,
 *   which would have shipped the whole thing and changed nothing. This case is
 *   the one that would have caught that, so it is the one that matters most in
 *   this file.
 *
 * TWO CASES, AND THE SECOND ONE IS NOT DECORATION
 *   A redirect assertion on its own passes just as happily against a loader
 *   that redirects everybody, including the invited account the product is for.
 *   The second case signs in through a real invite and asserts the same URL
 *   answers with results, so the refusal in the first case is shown to be about
 *   the SESSION and not about the query.
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
import { loader as translateLoader } from '../../app/routes/translate';
import { createTestUserSession, type TestUserSession } from '../fixtures/user-session';

const DB_HOST = process.env.DB_HOST;

/** The word searched. A seeded dictionary entry, so a signed-in run has something to answer with. */
const WORD = 'Haus';

let session: TestUserSession | null = null;

/**
 * `GET /?q=Haus`, with the given cookie or with none at all.
 *
 * `pattern: '/'` is the INDEX route id's pattern. Both ids run this same
 * loader, which is the property the gate depends on, and the sibling file
 * `anonymous-translate-alias-query-redirects.test.ts` drives the other one.
 */
async function loadIndexQuery(cookie: string | null) {
  const request = new Request(`https://translate.altan.fyi/?q=${WORD}&from=de&to=en`, {
    headers: cookie === null ? {} : { cookie },
  });
  return translateLoader({
    request,
    url: new URL(request.url),
    params: {},
    pattern: '/',
    context: new RouterContextProvider(),
  });
}

before(async () => {
  if (!DB_HOST) return;
  session = await createTestUserSession('index-query');
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

describe('an anonymous query on the index route', () => {
  it('redirects to the sign-in page', { skip: !DB_HOST ? 'DB_HOST not set' : false }, async () => {
    const thrown = await loadIndexQuery(null).then(
      () => null,
      (cause: unknown) => cause,
    );

    assert.ok(
      thrown instanceof Response,
      'GET /?q= answered a signed-out visitor with data instead of a redirect. This is the PRIMARY search URL, ' +
        'and an open one enqueues a billed enrichment job for the top hit on every single-word search.',
    );
    assert.equal(thrown.status, 302);
    // THE PATH, NOT THE WHOLE HEADER. The gate carries `?next=` since M191 so
    // the reader lands back where they were refused, and an assertion on the
    // full string would read as a broken gate the first time that changed.
    assert.equal(new URL(thrown.headers.get('location') ?? '', 'https://translate.altan.fyi').pathname, SIGN_IN_PATH);
  });

  it('answers the same URL with results once signed in', { skip: !DB_HOST ? 'DB_HOST not set' : false }, async () => {
    assert.ok(session !== null, 'the fixture account was not created, so this case would prove nothing');

    const data = await loadIndexQuery(session.cookie);

    assert.equal(data.q, WORD);
    assert.ok(
      data.hits.length > 0,
      `The signed-in search for '${WORD}' returned no hits. The refusal in the case above is then not evidence ` +
        'of a gate, because this loader is refusing or failing for everybody.',
    );
  });
});
