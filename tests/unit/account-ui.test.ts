/**
 * The account screens' load-bearing rules, tested where they live rather than
 * through a rendered DOM.
 *
 * There is no DOM library in this repo and none is added here: everything
 * below is pure logic that the components merely call.
 *
 * WHAT LEFT THIS FILE IN M191. The recovery-code save gate, the setup-wizard
 * reducer, the sign-in failure mapping and the wire-contract suite all tested
 * the encrypted account ceremony, and there is no ceremony now: signing up and
 * signing in are two form posts to route actions. The strength meter survives
 * because it still advises a reader choosing a password, and the route-module
 * walk survives because it still names where password hashing may live.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { passphraseStrengthKey, ratePassphrase } from '#app/lib/auth/password-strength';
import enCommon from '#app/locales/en/common.json';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));

describe('password strength', () => {
  /** The bands the catalog is willing to render, read from the catalog itself rather than restated here. */
  const catalogKeys = Object.keys(enCommon.account.passwordStrength);

  /** One sample per band, chosen to sit either side of the boundaries in `password-strength.ts`. */
  const samples = ['short', 'correct hors', 'correct horse battery staple'];

  it('emits exactly the keys the catalog defines, and every one of them', () => {
    const emitted = new Set(samples.map((sample) => passphraseStrengthKey(ratePassphrase(sample))));
    const expected = new Set(catalogKeys.map((band) => `account.passwordStrength.${band}`));
    assert.deepEqual([...emitted].toSorted(), [...expected].toSorted());
    assert.equal(expected.size, 3, 'the meter renders three bands, no more and no fewer');
  });

  it('resolves every emitted key to real copy in the shipped catalog', () => {
    // Built from the catalog's own entries, so a band renamed on either side
    // shows up as a missing lookup rather than as a silently absent string.
    const copyByBand = new Map(Object.entries(enCommon.account.passwordStrength));
    for (const sample of samples) {
      const key = passphraseStrengthKey(ratePassphrase(sample));
      const band = key.slice('account.passwordStrength.'.length);
      const copy = copyByBand.get(band);
      assert.ok(copy !== undefined, `no copy for ${key}`);
      assert.notEqual(copy, '', `empty copy for ${key}`);
    }
  });
});

describe('route modules', () => {
  /** Every route module, walked rather than listed: a list stops covering new routes the moment one is added. */
  function collectRoutes(directory: string): string[] {
    const found: string[] = [];
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const full = join(directory, entry.name);
      if (entry.isDirectory()) {
        found.push(...collectRoutes(full));
        continue;
      }
      if (!entry.name.endsWith('.ts') && !entry.name.endsWith('.tsx')) continue;
      found.push(relative(REPO_ROOT, full));
    }
    return found.toSorted();
  }

  const routeFiles = collectRoutes(join(REPO_ROOT, 'app/routes'));

  /**
   * Packages a route file must not reach for.
   *
   * `bcryptjs` IS used on this installation since M191, in exactly one module:
   * `app/services/auth.server.ts`. A route that hashes or compares a password
   * itself has grown a second authentication path beside the one place that
   * knows the work factor and the non-disclosure rules, and the second path is
   * where the rules get forgotten. `remix-auth` is the inherited form-auth
   * strategy this app has never used.
   */
  const FORBIDDEN_PACKAGES = ['bcryptjs', 'remix-auth-form', 'remix-auth'];

  it('walks a non-trivial number of route files', () => {
    assert.ok(routeFiles.length >= 20, `walked only ${routeFiles.length} route files`);
  });

  it('imports no password-hashing or form-auth package', () => {
    const hits: string[] = [];
    for (const file of routeFiles) {
      const source = readFileSync(join(REPO_ROOT, file), 'utf8');
      for (const packageName of FORBIDDEN_PACKAGES) {
        const pattern = new RegExp(`(?:from|import|require\\()\\s*['"]${packageName}['"]`);
        if (pattern.test(source)) hits.push(`${file}: ${packageName}`);
      }
    }
    assert.deepEqual(
      hits,
      [],
      `route files must not import ${FORBIDDEN_PACKAGES.join(', ')}, hashing belongs in auth.server.ts:\n${hits.join('\n')}`,
    );
  });

  it('detects a forbidden import when one is present (guards against a vacuous check)', () => {
    const pattern = new RegExp(`(?:from|import|require\\()\\s*['"]bcryptjs['"]`);
    assert.ok(pattern.test("import bcrypt from 'bcryptjs';"));
    assert.ok(pattern.test('const b = require("bcryptjs");'));
    assert.ok(!pattern.test("// bcryptjs is deliberately not imported here"));
  });
});
