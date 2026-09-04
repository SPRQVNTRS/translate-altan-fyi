/**
 * A signed-out visitor can still reach `/account` (M184 spec 03).
 *
 * WHY THIS CASE EXISTS AT ALL
 *   Every other case in this milestone shuts a door, and the cheapest way to
 *   make all of them green is to shut every door. That would ship an instance
 *   nobody can join, the operator included. `/account`, `/sign-up` and
 *   `/sign-in` are the front door: they are how an invited person becomes a
 *   reader, and a gate in front of them is a gate nobody can ever pass.
 *
 * TWO LINKS, BOTH CHECKED
 *   Link one: `/account` is not nested under the gated layout, asserted by
 *   walking the real `app/routes.ts` config, because the fastest way to break
 *   this is to move one line in that file. Link two: its loader answers a
 *   request with no cookie, and answers `null` rather than throwing, which is
 *   the contract a public account screen needs.
 *
 * THE FRONT DOOR IS CHECKED AS A SET, not one route. `sign-up.tsx` and
 * `sign-in.tsx` are asserted ungated in the same case, because losing either
 * one has the same effect as losing this one.
 *
 * NO ROW IS CREATED OR DELETED. Both cases only read.
 *
 * THE PRECONDITION IS A REACHABLE DATABASE. `DB_HOST`, nothing else: the loader
 * reaches the database on the signed-in path and would not be exercised
 * honestly without one.
 */
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { RouterContextProvider } from 'react-router';

import type { RouteConfigEntry } from '@react-router/dev/routes';

import routes from '../../app/routes';
import { closePool, poolInitialized } from '../../drizzle/db';
import { loader as accountLoader } from '../../app/routes/account';

const DB_HOST = process.env.DB_HOST;

const GATED_LAYOUT_FILE = 'routes/_app.gated.tsx';

/** The three files an invited person has to reach before they have an account. */
const FRONT_DOOR_FILES = ['routes/account.tsx', 'routes/sign-up.tsx', 'routes/sign-in.tsx'];

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

after(async () => {
  // THE POOL FINISHES OPENING BEFORE IT IS CLOSED. `drizzle/db.ts` kicks off
  // `ensureHostIndexes` behind `poolInitialized` at import time, and a short
  // test file can reach `closePool()` first, which turns a passing run into
  // "Cannot use a pool after calling end on the pool" reported as a failure.
  await poolInitialized;
  await closePool();
});

describe('the front door stays open', () => {
  it('keeps the account and sync screens out of the gated layout', { skip: !DB_HOST ? 'DB_HOST not set' : false }, () => {
    const gated = filesUnder(routes, GATED_LAYOUT_FILE);
    const shut = FRONT_DOOR_FILES.filter((file) => gated.includes(file));

    assert.deepEqual(
      shut,
      [],
      `These are the screens an invited person needs BEFORE they have an account, and they are now behind the ` +
        `account gate: ${shut.join(', ')}. An instance gated this way cannot be joined by anybody, including ` +
        'the operator holding the bootstrap token.',
    );
  });

  it('answers a signed-out visitor with the signed-out state', { skip: !DB_HOST ? 'DB_HOST not set' : false }, async () => {
    const request = new Request('https://translate.altan.fyi/account');
    const data = await accountLoader({
      request,
      url: new URL(request.url),
      params: {},
      pattern: '/account',
      context: new RouterContextProvider(),
    });

    assert.equal(data.email, null, 'the anonymous account screen claimed an address');
  });
});
