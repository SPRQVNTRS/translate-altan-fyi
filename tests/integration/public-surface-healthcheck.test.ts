/**
 * `/healthcheck` answers 200 to a request carrying no session cookie
 * (M184 spec 04).
 *
 * WHY THIS CASE EXISTS
 *   Gatus polls this path from outside, and Docker's own health probe calls it
 *   from inside. Neither holds a cookie, and neither can be given one. A gate
 *   in front of it would not look like an outage in this repo: lint, typecheck
 *   and the unit suite would all stay green, and the first report would be a
 *   red dashboard and a container restarting in a loop. Spec 03 moved the app
 *   shell under a new gated layout, and one wrong line of nesting in
 *   `app/routes.ts` is all it would take.
 *
 * TWO LINKS, PLUS A CHECK THAT THE CHECK MEANS ANYTHING
 *   Link one: the route sits at the TOP LEVEL of the real `app/routes.ts`
 *   config, under no layout at all, so there is no module in front of it that
 *   could refuse anybody. It is asserted by walking that config rather than by
 *   reading it.
 *   Link two: the loader answers `200 OK` for a request with no cookie.
 *   The third case is the honesty check. Both assertions above would also pass
 *   on an instance whose account gate did nothing whatsoever, so the gate is
 *   run against the same cookie-less request and must refuse it. Without that,
 *   a green run here would prove only that nothing anywhere is gated.
 *
 * NO ROW IS CREATED, READ DESTRUCTIVELY, OR DELETED. Every case only reads.
 *
 * THE PRECONDITION IS A REACHABLE DATABASE. `DB_HOST`, nothing else: the gate
 * this file runs for contrast reads accounts on its admitted path, and the
 * import opens the app's pool, which `after()` closes.
 */
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { RouterContextProvider, type MiddlewareFunction } from 'react-router';

import type { RouteConfigEntry } from '@react-router/dev/routes';

import routes from '../../app/routes';
import { closePool, poolInitialized } from '../../drizzle/db';
import { accountMiddleware } from '../../app/middleware/auth';
import { ACCOUNT_LOGIN_PATH } from '../../app/services/account-session.server';
import { loader as healthcheckLoader } from '../../app/routes/healthcheck';

const DB_HOST = process.env.DB_HOST;

const HEALTHCHECK_FILE = 'routes/healthcheck.ts';

/**
 * The chain of layout files a route file sits inside, outermost first.
 *
 * It walks the REAL config that `app/routes.ts` exports, in the shape
 * `@react-router/dev/routes` builds, so there is no second description of the
 * routing tree here to fall out of step with the first. An empty chain means
 * the file is registered at the top level, which is the claim this file makes.
 */
function ancestorsOf(entries: readonly RouteConfigEntry[], file: string): string[] | null {
  for (const entry of entries) {
    if (entry.file === file) return [];
    const inner = ancestorsOf(entry.children ?? [], file);
    if (inner !== null) return [entry.file, ...inner];
  }
  return null;
}

/**
 * Runs the account gate over one cookie-less request, and reports what it did.
 *
 * The middleware is called the way the router calls it. `next` is the rest of
 * the chain: reaching it means the caller was admitted, which is the only
 * positive answer this function can observe, because an admitted middleware
 * returns nothing at all.
 */
async function runGateAnonymously(): Promise<'admitted' | Response> {
  const request = new Request('https://translate.altan.fyi/history');
  const middleware: MiddlewareFunction = accountMiddleware;
  try {
    await middleware(
      {
        request,
        url: new URL(request.url),
        params: {},
        pattern: '/history',
        context: new RouterContextProvider(),
      },
      async () => new Response(null),
    );
    return 'admitted';
  } catch (cause) {
    // A `redirect()` is a `Response`, and that is the only refusal this gate
    // has. Anything else is a real fault, and rethrowing it here keeps a
    // database outage from being reported as a successful refusal.
    if (cause instanceof Response) return cause;
    throw cause;
  }
}

after(async () => {
  // THE POOL FINISHES OPENING BEFORE IT IS CLOSED. `drizzle/db.ts` kicks off
  // `ensureHostIndexes` behind `poolInitialized` at import time, and a short
  // test file can reach `closePool()` first, which turns a passing run into
  // "Cannot use a pool after calling end on the pool" reported as a failure.
  await poolInitialized;
  await closePool();
});

describe('the healthcheck stays public', () => {
  it('is registered under no layout at all', { skip: !DB_HOST ? 'DB_HOST not set' : false }, () => {
    const ancestors = ancestorsOf(routes, HEALTHCHECK_FILE);

    assert.ok(ancestors !== null, `${HEALTHCHECK_FILE} is not registered in app/routes.ts at all, so nothing serves it.`);
    assert.deepEqual(
      ancestors,
      [],
      `${HEALTHCHECK_FILE} is now nested inside ${ancestors?.join(' > ')}. A layout in front of it can redirect, ` +
        'and the two callers of this path, Gatus and the container health probe, hold no cookie and cannot follow ' +
        'one. Register it at the top level.',
    );
  });

  it('answers 200 to a request with no cookie', { skip: !DB_HOST ? 'DB_HOST not set' : false }, async () => {
    const response = healthcheckLoader();

    assert.equal(response.status, 200);
    assert.equal(await response.text(), 'OK');
  });

  it('is checked against a gate that is actually live', { skip: !DB_HOST ? 'DB_HOST not set' : false }, async () => {
    // WITHOUT THIS CASE THE TWO ABOVE PROVE NOTHING. They would both pass on an
    // instance where the account gate had been deleted, which is the state this
    // milestone exists to prevent. So the same shape of anonymous request is
    // put to the gate, and the gate must turn it away.
    const outcome = await runGateAnonymously();

    assert.ok(outcome instanceof Response, 'the account gate admitted a request carrying no session, so it is not gating anything');
    assert.equal(outcome.status, 302);
    assert.equal(outcome.headers.get('location'), ACCOUNT_LOGIN_PATH);
  });
});
