/**
 * The language bar's target must be the target the search actually ran with.
 *
 * THE DEFECT THIS FILE PINS DOWN. A browser walk on 2026-09-04 loaded
 * `/?from=detect&to=de&q=umwerfen` signed in and found the bar reading
 * "Deutsch" while every result link carried `?to=en`. `resolveLanguagePair`
 * repairs a target that collides with a STATED source, but `from=detect`
 * states no source at all, so nothing collides when the pair is resolved.
 * `chooseDirection` then resolves the source to `de` from the query itself and
 * repairs `to` to `en`, because a translation is an edge between two DIFFERENT
 * languages. The loader used to hand `SearchPanes` the unreconciled `pair`
 * while the search, and every result link, used `direction`, so the bar and
 * the results disagreed about which language the results were in.
 *
 * WHY THIS HAS TO BE A LOADER-LEVEL TEST, NOT ONLY A UNIT TEST ON THE PURE
 * RECONCILER. The defect was two values the loader returns disagreeing with
 * each other. A unit test on `reconcilePairWithDirection` alone (see
 * `tests/unit/language-pair.test.ts`) proves the function is correct; it
 * cannot prove the loader actually calls it on the branch that matters. Only a
 * test that reads `pair` and `direction` off one real call to
 * `app/routes/translate.tsx`'s loader can catch the two disagreeing.
 *
 * THE ASSERTION IS THE INVARIANT, NOT THE STRING `en`. `pair.target` must equal
 * `direction.to`, whatever `direction.to` turns out to be. Pinning the literal
 * `en` would make this file itself the next thing to disagree with the
 * dictionary if the seeded corpus ever changes.
 *
 * THE PRECONDITION IS A REACHABLE DATABASE. `DB_HOST`, nothing else: no API
 * key and no server on :3456. Every case gates on it, which
 * `tests/unit/integration-tests-self-skip.test.ts` enforces one for one.
 */
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { RouterContextProvider } from 'react-router';

import { pool } from '../../drizzle/db';
import { DETECT } from '../../app/lib/dictionary/language-pair';
import { loader as translateLoader } from '../../app/routes/translate';
import { createTestUserSession, type TestUserSession } from '../fixtures/user-session';

const DB_HOST = process.env.DB_HOST;

after(async () => {
  await pool.end();
});

/**
 * One `/?...` request, signed in as `session`.
 *
 * A signed-in session is required, since M184: the loader redirects a
 * signed-out caller to `/sign-in` before it ever reads the dictionary, so a
 * request with no cookie would assert nothing about the search branch this
 * file is testing.
 */
function searchRequest(session: TestUserSession, params: { from: string; to: string; q: string }): Request {
  const url = new URL('https://kenning.altan.fyi/');
  url.searchParams.set('from', params.from);
  url.searchParams.set('to', params.to);
  url.searchParams.set('q', params.q);
  return new Request(url, { headers: { cookie: session.cookie } });
}

/** One loader call, decoded down to the two fields under test. */
async function loadedPairAndDirection(
  session: TestUserSession,
  params: { from: string; to: string; q: string },
): Promise<{ pairTarget: string; directionTo: string; pairSource: string }> {
  const request = searchRequest(session, params);
  const data = await translateLoader({
    request,
    url: new URL(request.url),
    params: {},
    pattern: '/',
    context: new RouterContextProvider(),
  });
  return { pairTarget: data.pair.target, directionTo: data.direction.to, pairSource: data.pair.source };
}

describe('the language bar the loader hands back agrees with the search it ran', () => {
  it(
    'reconciles a detected source against a stated target that collided with it',
    { skip: !DB_HOST ? 'DB_HOST not set' : false },
    async () => {
      const session = await createTestUserSession('bar-detect-collision');
      try {
        // `umwerfen` is a seeded German headword. Stated source is `detect`,
        // stated target is `de`: nothing collides at resolve time, so this is
        // exactly the shape of request the browser walk found broken.
        const { pairTarget, directionTo, pairSource } = await loadedPairAndDirection(session, {
          from: DETECT,
          to: 'de',
          q: 'umwerfen',
        });

        assert.equal(
          pairTarget,
          directionTo,
          `the bar showed a target of "${pairTarget}" while the search ran with "${directionTo}"`,
        );
        assert.equal(pairSource, DETECT, 'the source must stay a statement of detection, not silently pinned');
      } finally {
        await session.dispose();
      }
    },
  );

  it(
    'reconciles the same collision when it is stated directly',
    { skip: !DB_HOST ? 'DB_HOST not set' : false },
    async () => {
      const session = await createTestUserSession('bar-direct-collision');
      try {
        // `from=de&to=de` names no edge that exists, so `chooseDirection`
        // repairs `to`. This is the collision `resolveLanguagePair` DOES catch
        // on its own, kept here as a control: the invariant must hold whether
        // or not the collision was already visible before the search ran.
        const { pairTarget, directionTo } = await loadedPairAndDirection(session, {
          from: 'de',
          to: 'de',
          q: 'umwerfen',
        });

        assert.equal(
          pairTarget,
          directionTo,
          `the bar showed a target of "${pairTarget}" while the search ran with "${directionTo}"`,
        );
      } finally {
        await session.dispose();
      }
    },
  );
});
