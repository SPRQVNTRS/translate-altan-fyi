/**
 * The three legal documents answer a request carrying no session cookie
 * (M184 spec 04).
 *
 * WHY THESE PAGES ARE CHECKED SEPARATELY FROM THE REST OF THE PUBLIC SURFACE
 *   Reachability is the whole duty. Section 5 DDG binds the operator to keep
 *   the provider identification available to ANYBODY who asks, and a privacy
 *   notice that only a signed-in reader can open is not a notice. So this is
 *   not a nice-to-have alongside the landing page: an instance that gates
 *   `/legal/imprint` is out of compliance the moment it answers a request.
 *   Spec 03 moved the app shell under a new gated layout, and these pages live
 *   one layout over, in `_public`. One wrong line of nesting reaches them.
 *
 * THREE LINKS, AND THE LAST ONE IS THE HONESTY CHECK
 *   Link one: each of the three files sits under `routes/_public.tsx` and under
 *   no other layout, asserted by walking the real `app/routes.ts` config rather
 *   than by reading it.
 *   Link two: no module in that chain carries anything that could refuse an
 *   anonymous caller. Today none of them exports a `loader` or a `middleware`
 *   at all, and the assertion says exactly that. If a legal page ever needs
 *   one, this case is where somebody has to come and prove it serves a request
 *   with no cookie, instead of quietly shipping a page nobody can open.
 *   Link three: both assertions above would also pass on an instance whose
 *   account gate did nothing, so the gate is run against an anonymous request
 *   and must refuse it. Without that, a green run here would prove only that
 *   nothing anywhere is gated.
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
import { authMiddleware } from '../../app/middleware/auth';
import { SIGN_IN_PATH } from '../../app/lib/auth/paths';
import * as publicLayoutModule from '../../app/routes/_public';
import * as imprintModule from '../../app/routes/legal/imprint';
import * as privacyModule from '../../app/routes/legal/privacy';
import * as termsModule from '../../app/routes/legal/terms';

const DB_HOST = process.env.DB_HOST;

/** The layout the three documents are expected to sit under, and nothing else. */
const PUBLIC_LAYOUT_FILE = 'routes/_public.tsx';

const LEGAL_ROUTE_FILES = [
  'routes/legal/imprint.tsx',
  'routes/legal/privacy.tsx',
  'routes/legal/terms.tsx',
];

/** The chain a request walks through, named the way `app/routes.ts` names it. */
const CHAIN_MODULES = [
  { file: PUBLIC_LAYOUT_FILE, module: publicLayoutModule },
  { file: 'routes/legal/imprint.tsx', module: imprintModule },
  { file: 'routes/legal/privacy.tsx', module: privacyModule },
  { file: 'routes/legal/terms.tsx', module: termsModule },
];

/**
 * The chain of layout files a route file sits inside, outermost first.
 *
 * It walks the REAL config that `app/routes.ts` exports, in the shape
 * `@react-router/dev/routes` builds, so there is no second description of the
 * routing tree here to fall out of step with the first.
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
  const middleware: MiddlewareFunction = authMiddleware;
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

describe('the legal documents stay public', () => {
  it('keeps all three under the public layout only', { skip: !DB_HOST ? 'DB_HOST not set' : false }, () => {
    for (const file of LEGAL_ROUTE_FILES) {
      const ancestors = ancestorsOf(routes, file);

      assert.ok(ancestors !== null, `${file} is not registered in app/routes.ts at all, so nothing serves it.`);
      assert.deepEqual(
        ancestors,
        [PUBLIC_LAYOUT_FILE],
        `${file} sits under ${ancestors?.join(' > ')} rather than under ${PUBLIC_LAYOUT_FILE} alone. Every layout ` +
          'in front of a legal document can redirect, and a provider identification a stranger cannot open does ' +
          'not satisfy the duty to publish one.',
      );
    }
  });

  it('carries nothing in that chain that could refuse an anonymous caller', { skip: !DB_HOST ? 'DB_HOST not set' : false }, () => {
    for (const { file, module } of CHAIN_MODULES) {
      const refusalSurface = ['middleware', 'loader'].filter((name) => name in module);

      assert.deepEqual(
        refusalSurface,
        [],
        `${file} now exports ${refusalSurface.join(' and ')}. These pages are rendered from static copy today and ` +
          'need neither, so this is the moment to prove the new code serves a request with no cookie: assert that ' +
          'here, then relax this case. Do not relax it first.',
      );
    }
  });

  it('is checked against a gate that is actually live', { skip: !DB_HOST ? 'DB_HOST not set' : false }, async () => {
    // WITHOUT THIS CASE THE TWO ABOVE PROVE NOTHING. Both would pass on an
    // instance where the account gate had been deleted, which is the state this
    // milestone exists to prevent. So an anonymous request is put to the gate,
    // and the gate must turn it away.
    const outcome = await runGateAnonymously();

    assert.ok(outcome instanceof Response, 'the account gate admitted a request carrying no session, so it is not gating anything');
    assert.equal(outcome.status, 302);
    // THE PATH, NOT THE WHOLE HEADER. The gate carries `?next=` since M191 so
    // the reader lands back where they were refused, and an assertion on the
    // full string would read as a broken gate the first time that changed.
    assert.equal(new URL(outcome.headers.get('location') ?? '', 'https://translate.altan.fyi').pathname, SIGN_IN_PATH);
  });
});
