/**
 * Guard: every case under `tests/integration/` must self-skip without its
 * environment precondition, which is `TEST_API_KEY` or `DB_HOST`.
 *
 * The repo's only test gate is `.githooks/pre-push` (lint → typecheck → unit →
 * content:validate → build). It deliberately does NOT run `tests/integration/`,
 * because every case there needs infrastructure the gate does not start: either
 * `TEST_API_KEY` plus a server on localhost:3456, or `DB_HOST` plus a live
 * database. In the gate they would assert nothing while looking green.
 *
 * That exclusion is only safe while the self-skip property holds. A file added
 * to `tests/integration/` whose cases do NOT self-skip is silently never
 * executed by anything. This test makes that assumption enforceable instead of
 * a comment nobody reads.
 *
 * WHY THE ACCEPTED PRECONDITION WAS WIDENED
 *   The guard originally recognised only `TEST_API_KEY`, because every
 *   integration case was a CLI case talking to a live HTTP server. The first
 *   DB-backed case (`dictionary-schema.test.ts`) needs a database and neither
 *   an API key nor a server. Gating it on `TEST_API_KEY` alone would have named
 *   a precondition it does not actually have, so the guard now accepts either
 *   token. The invariant is unchanged: every case must still self-skip on a
 *   missing environment precondition. What widened is the set of preconditions,
 *   not the requirement to declare one.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

/** Resolved from the module's own location so the working directory is irrelevant. */
const INTEGRATION_DIR = resolve(import.meta.dirname, '../integration');

/** `it(` / `test(` at a statement position — `describe(` and `.it(` do not match. */
const TEST_CASE_PATTERN = /(^|[^.\w])(it|test)\s*\(/g;

/** A `skip:` option whose value mentions an environment precondition. */
const SKIP_GUARD_PATTERN = /skip:\s*[^,\n]*(TEST_API_KEY|DB_HOST)/g;

function listIntegrationTestFiles(): string[] {
  return readdirSync(INTEGRATION_DIR, { recursive: true, encoding: 'utf8' })
    .filter((entry) => entry.endsWith('.test.ts'))
    .toSorted();
}

function countMatches(source: string, pattern: RegExp): number {
  return source.match(pattern)?.length ?? 0;
}

const testFiles = listIntegrationTestFiles();

describe('tests/integration self-skip guard', () => {
  it('discovers at least one integration test file', () => {
    assert.ok(
      testFiles.length > 0,
      `No *.test.ts files found under ${INTEGRATION_DIR}. Either the directory moved ` +
        'or the enumeration broke — this guard cannot protect an empty list.',
    );
  });

  for (const relativePath of testFiles) {
    it(`${relativePath}: every test case declares an environment precondition`, () => {
      const source = readFileSync(join(INTEGRATION_DIR, relativePath), 'utf8');
      const caseCount = countMatches(source, TEST_CASE_PATTERN);
      const guardCount = countMatches(source, SKIP_GUARD_PATTERN);

      const remedy =
        `${relativePath}: ${caseCount} test case(s) but ${guardCount} skip guard(s). ` +
        'The pre-push gate does not run tests/integration/, so an unguarded case is never ' +
        'executed by anything. Every case must self-skip on the precondition it actually has: ' +
        "TEST_API_KEY (a live server on :3456) or DB_HOST (a live database). Add " +
        "{ skip: !TEST_API_KEY ? '...' : false } or { skip: !DB_HOST ? '...' : false } to the " +
        'unguarded case, or move the file out of tests/integration/ if it needs neither.';

      assert.ok(caseCount > 0, remedy);
      assert.equal(guardCount, caseCount, remedy);
    });
  }
});
