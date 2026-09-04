/**
 * A reader who already holds an account does not get the account-creation form
 * (M189).
 *
 * WHY THIS CASE EXISTS
 *   `/sign-up` and `/sign-in` are public, and they must stay public: a gate in
 *   front of the sign-in page is a gate nobody can ever pass. That correct rule
 *   left a wrong screen behind. A signed-in reader following an old bookmark,
 *   or pressing back after finishing sign-up, was handed a form offering them a
 *   SECOND account. Nothing in a typecheck, a lint or a status assertion can
 *   see that.
 *
 * IT DRIVES THE REAL LOADERS WITH A REAL SESSION COOKIE. The user row and the
 * cookie both come from `tests/fixtures/user-session.ts`, which seals the
 * cookie with the same `commitUserSession` the sign-in action uses, and the
 * loaders are imported from the route files. A hand-built cookie would prove
 * only that this file can write a header.
 *
 * THE REFUSAL IS A REDIRECT, WHICH A LOADER THROWS. So each case catches, and
 * asserts that what it caught is a `Response` with a `location`. `assert.throws`
 * would pass on any thrown value, including the failure this is looking for.
 *
 * AND ONE CASE HOLDS THE DOOR OPEN. Asserting two redirects is satisfied by a
 * pair of loaders that redirect everybody, which would lock every new reader
 * out of the only screen that can admit them. The last case is the signed-out
 * stranger, and it asserts they still get the form.
 *
 * ISOLATION. One user, created here and deleted in `after()`, by id. Nothing
 * else in the table is read, counted or removed.
 *
 * WHAT THIS FILE MUST NEVER PRINT. No assertion message may carry the session
 * cookie, which is a bearer credential.
 *
 * THE PRECONDITION IS A REACHABLE DATABASE. `DB_HOST`, nothing else.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { RouterContextProvider } from 'react-router';

import { closePool, poolInitialized } from '../../drizzle/db';
import { createTestUserSession, type TestUserSession } from '../fixtures/user-session';
import { loader as signUpLoader } from '../../app/routes/sign-up';
import { loader as signInLoader } from '../../app/routes/sign-in';

const DB_HOST = process.env.DB_HOST;

/** The one user this file creates, or `null` before `before()` has run. */
let session: TestUserSession | null = null;

/** The arguments the router hands a loader, for one URL and one optional cookie. */
function loaderArgs(input: { url: string; pattern: string; cookie: string | null }) {
  const request = new Request(input.url, {
    headers: input.cookie === null ? undefined : { cookie: input.cookie },
  });
  return {
    request,
    url: new URL(request.url),
    params: {},
    pattern: input.pattern,
    context: new RouterContextProvider(),
  };
}

/**
 * The `Response` a loader threw, or a failure naming what it threw instead.
 *
 * Generic over the loader's own answer rather than taking `unknown`, so the
 * failure message below prints the data a non-redirecting loader returned.
 */
async function catchThrownResponse<TAnswer>(run: () => Promise<TAnswer>): Promise<Response> {
  try {
    const answered = await run();
    assert.fail(`the loader answered instead of redirecting: ${JSON.stringify(answered)}`);
  } catch (cause) {
    if (cause instanceof Response) return cause;
    throw cause;
  }
}

before(async () => {
  if (!DB_HOST) return;
  session = await createTestUserSession('doors');
});

after(async () => {
  await session?.dispose();
  // THE POOL FINISHES OPENING BEFORE IT IS CLOSED. `drizzle/db.ts` kicks off
  // `ensureHostIndexes` behind `poolInitialized` at import time, and a short
  // test file can reach `closePool()` first, which turns a passing run into
  // "Cannot use a pool after calling end on the pool" reported as a failure.
  await poolInitialized;
  await closePool();
});

describe('the doors, for somebody who is already through them', () => {
  it(
    'sends a signed-in reader from /sign-up to /account',
    { skip: !DB_HOST ? 'DB_HOST not set' : false },
    async () => {
      const response = await catchThrownResponse(() =>
        signUpLoader(loaderArgs({ url: 'https://translate.altan.fyi/sign-up', pattern: '/sign-up', cookie: session?.cookie ?? null })),
      );

      assert.equal(response.status, 302);
      assert.equal(
        response.headers.get('location'),
        '/account',
        'A reader holding an account was left on the creation form, which offers them a second one.',
      );
    },
  );

  it(
    'sends a signed-in reader from /sign-in to /account',
    { skip: !DB_HOST ? 'DB_HOST not set' : false },
    async () => {
      const response = await catchThrownResponse(() =>
        signInLoader(loaderArgs({ url: 'https://translate.altan.fyi/sign-in', pattern: '/sign-in', cookie: session?.cookie ?? null })),
      );

      assert.equal(response.status, 302);
      assert.equal(response.headers.get('location'), '/account');
    },
  );

  it(
    'still gives a stranger both forms',
    { skip: !DB_HOST ? 'DB_HOST not set' : false },
    async () => {
      // WITHOUT THIS CASE THE TWO ABOVE ARE SATISFIED BY A PAIR OF LOADERS THAT
      // REDIRECT EVERYBODY, which is an instance nobody can join.
      const signUpData = await signUpLoader(
        loaderArgs({ url: 'https://translate.altan.fyi/sign-up', pattern: '/sign-up', cookie: null }),
      );
      assert.equal(
        signUpData,
        null,
        'A signed-out stranger was redirected away from the account-creation form, so this instance cannot be joined.',
      );

      // The sign-in loader answers with the `?next=` destination rather than
      // `null`, so the assertion is that it RETURNED at all: a refusal here is
      // a thrown redirect, which would fail the await above.
      const signInData = await signInLoader(
        loaderArgs({ url: 'https://translate.altan.fyi/sign-in', pattern: '/sign-in', cookie: null }),
      );
      assert.deepEqual(signInData, { next: '/' }, 'a signed-out visitor was turned away from the sign-in form');
    },
  );
});
