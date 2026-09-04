/**
 * A signed-out visitor on `/entry/:headwordId` is sent to the sign-in page
 * (M184 spec 03).
 *
 * WHY THIS IS CHECKED EXPLICITLY RATHER THAN ASSUMED
 *   The entry page enqueues enrichment too: it calls the same
 *   `resolveTriggeredPanel` the search screen calls, with the same arguments.
 *   If entry pages had stayed public the hole would simply have moved from
 *   `/?q=<word>` to `/entry/<id>`, and every other case in this milestone would
 *   still be green. The first draft of the spec left this implicit. It is not
 *   implicit here.
 *
 * WHAT IT ACTUALLY DRIVES, AND WHY NOT THE LOADER
 *   The refusal is not in `entry.$headwordId.tsx`. It is `authMiddleware`,
 *   carried by the pathless `_app.gated` layout the route is nested under, and
 *   middleware runs before any loader. Calling the entry loader directly would
 *   therefore prove nothing at all: it would answer happily, exactly as it does
 *   in production AFTER the middleware has admitted the caller.
 *
 *   So the claim is a chain, and both links are checked. Link one: the route is
 *   nested under the gated layout, asserted by walking the real `app/routes.ts`
 *   config rather than by reading it. Link two: that layout's middleware
 *   refuses an anonymous request and admits a real invited session, asserted by
 *   running it. Neither half alone is the claim, and a change that breaks
 *   either one turns this case red.
 *
 * ISOLATION
 *   One account and one invite, from the shared fixture, removed in `after()`.
 *   Nothing else is written and nothing pre-existing is read.
 *
 * THE PRECONDITION IS A REACHABLE DATABASE. `DB_HOST`, nothing else.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { RouterContextProvider, type MiddlewareFunction } from 'react-router';

import type { RouteConfigEntry } from '@react-router/dev/routes';

import routes from '../../app/routes';
import { closePool, poolInitialized } from '../../drizzle/db';
import { authMiddleware } from '../../app/middleware/auth';
import { SIGN_IN_PATH } from '../../app/lib/auth/paths';
import { createTestUserSession, type TestUserSession } from '../fixtures/user-session';

const DB_HOST = process.env.DB_HOST;

/** The layout file that carries the gate, and the route that must sit under it. */
const GATED_LAYOUT_FILE = 'routes/_app.gated.tsx';
const ENTRY_ROUTE_FILE = 'routes/entry.$headwordId.tsx';

let session: TestUserSession | null = null;

/** One route entry of the real config, as `@react-router/dev/routes` builds it. */
/**
 * Every descendant file of the first entry with this file, at any depth.
 *
 * It walks the REAL config that `app/routes.ts` exports, in the shape
 * `@react-router/dev/routes` builds, so there is no second description of the
 * routing tree here to fall out of step with the first.
 */
function filesUnder(entries: readonly RouteConfigEntry[], file: string): string[] {
  for (const entry of entries) {
    if (entry.file === file) return collectFiles(entry.children ?? []);
    const found = filesUnder(entry.children ?? [], file);
    if (found.length > 0) return found;
  }
  return [];
}

function collectFiles(entries: readonly RouteConfigEntry[]): string[] {
  return entries.flatMap((entry) => [entry.file, ...collectFiles(entry.children ?? [])]);
}

/**
 * Runs the gate over one request, and reports what it did.
 *
 * The middleware is called the way the router calls it. `next` is the rest of
 * the chain: reaching it means the caller was admitted, which is the only
 * positive answer this function can observe, because an admitted middleware
 * returns nothing at all.
 */
async function runGate(cookie: string | null): Promise<'admitted' | Response> {
  const request = new Request('https://translate.altan.fyi/entry/00000000-0000-0000-0000-000000000000', {
    headers: cookie === null ? {} : { cookie },
  });
  const middleware: MiddlewareFunction = authMiddleware;
  try {
    await middleware(
      {
        request,
        url: new URL(request.url),
        params: { headwordId: '00000000-0000-0000-0000-000000000000' },
        pattern: '/entry/:headwordId',
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

before(async () => {
  if (!DB_HOST) return;
  session = await createTestUserSession('entry-gate');
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

describe('the entry page is gated', () => {
  it('is nested under the layout that carries the gate', { skip: !DB_HOST ? 'DB_HOST not set' : false }, () => {
    const gated = filesUnder(routes, GATED_LAYOUT_FILE);

    assert.ok(
      gated.includes(ENTRY_ROUTE_FILE),
      `${ENTRY_ROUTE_FILE} is not nested under ${GATED_LAYOUT_FILE} in app/routes.ts, so it inherits no gate. ` +
        'It enqueues enrichment through the same shared trigger the search screen uses, so a public entry page ' +
        `moves the hole rather than closing it. Files currently gated: ${gated.join(', ')}`,
    );
  });

  it('refuses an anonymous request with a redirect to sign in', { skip: !DB_HOST ? 'DB_HOST not set' : false }, async () => {
    const outcome = await runGate(null);

    assert.ok(outcome instanceof Response, 'the gate admitted a request carrying no session at all');
    assert.equal(outcome.status, 302);
    // THE PATH, NOT THE WHOLE HEADER. The gate carries `?next=` since M191 so
    // the reader lands back where they were refused, and an assertion on the
    // full string would read as a broken gate the first time that changed.
    assert.equal(new URL(outcome.headers.get('location') ?? '', 'https://translate.altan.fyi').pathname, SIGN_IN_PATH);
  });

  it('admits a real invited session', { skip: !DB_HOST ? 'DB_HOST not set' : false }, async () => {
    // THE MEASUREMENT CHAIN AGAIN. A gate that refused everybody would pass the
    // case above and lock every invited reader out of the product, which is the
    // failure this milestone can most easily ship by accident.
    assert.ok(session !== null, 'the fixture account was not created, so this case would prove nothing');

    const outcome = await runGate(session.cookie);

    assert.equal(
      outcome,
      'admitted',
      'the gate refused a real, invited, signed-in account. The gate that used to do exactly this was ' +
        '`authMiddleware`, which also demanded a linked `users` row; it went with that table in M189.',
    );
  });
});
