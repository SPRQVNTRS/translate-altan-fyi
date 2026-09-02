/**
 * The sync screens' load-bearing rules, tested where they live rather than
 * through a rendered DOM.
 *
 * There is no DOM library in this repo and none is added here: everything
 * below is pure logic that the components merely call. That is the point of
 * the split. The confirmation gate in particular is a security rule, so it is
 * a function a test can drive, not a comparison buried in an event handler
 * where only review could ever have caught a regression.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { isRecoveryCodeConfirmed } from '#app/components/sync/recovery-confirmation';
import { formatRecoveryCode } from '#app/lib/e2ee/client/recovery-kek';
import { passphraseStrengthKey, ratePassphrase } from '#app/lib/e2ee/flows/passphrase-strength';
import {
  initialSyncSetupState,
  syncSetupReducer,
  type SyncSetupState,
} from '#app/lib/e2ee/flows/setup-flow';
import enCommon from '#app/locales/en/common.json';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));

/** A fixed 20-byte code, so the assertions below do not depend on the CSPRNG. */
const RECOVERY_CODE = formatRecoveryCode(Uint8Array.from({ length: 20 }, (_, index) => index * 7 + 1));

/** Walks the wizard to the one state that can finish: the account card, with the code on screen and nothing confirmed. */
function reachAccountCard(): SyncSetupState {
  let state = initialSyncSetupState();
  state = syncSetupReducer(state, { type: 'detailsSubmitted' });
  state = syncSetupReducer(state, { type: 'setupSucceeded', handle: 'k7m2q9r4t1', recoveryCode: RECOVERY_CODE });
  return state;
}

/**
 * Exactly what the confirm step's submit handler does: rate the typed code,
 * feed the verdict to the reducer, then ask to finish. Driving the real pair
 * is the point, a test that only called the reducer would prove the gate holds
 * for a caller that already decided the answer.
 */
function submitTypedCode(state: SyncSetupState, typed: string): SyncSetupState {
  if (state.kind !== 'show-account-card') throw new Error(`expected an account card, got ${state.kind}`);
  const isConfirmed = isRecoveryCodeConfirmed({ typed, expected: state.recoveryCode });
  const acknowledged = syncSetupReducer(state, { type: 'confirmSavedToggled', checked: isConfirmed });
  return syncSetupReducer(acknowledged, { type: 'finishRequested' });
}

describe('recovery-code confirmation gate', () => {
  it('does not complete setup when the typed code is wrong', () => {
    const card = reachAccountCard();
    const wrong = `${RECOVERY_CODE.slice(0, -1)}${RECOVERY_CODE.endsWith('0') ? '1' : '0'}`;
    assert.notEqual(wrong, RECOVERY_CODE, 'the wrong code must actually differ');

    const state = submitTypedCode(card, wrong);
    assert.equal(state.kind, 'show-account-card');
  });

  it('does not complete setup on an empty, a truncated, an overlong or a reordered entry', () => {
    const card = reachAccountCard();
    for (const attempt of [
      '',
      RECOVERY_CODE.slice(0, 10),
      // One character too many. Base32 packs five bits per character, so this
      // decodes to the SAME bytes as the real code: the gate has to count
      // characters as well as compare bytes, and this case is what proves it.
      `${RECOVERY_CODE}Z`,
      RECOVERY_CODE.split('-').toReversed().join('-'),
    ]) {
      assert.equal(submitTypedCode(card, attempt).kind, 'show-account-card', `accepted ${JSON.stringify(attempt)}`);
    }
  });

  it('completes setup when the typed code matches', () => {
    const state = submitTypedCode(reachAccountCard(), RECOVERY_CODE);
    assert.equal(state.kind, 'complete');
  });

  it('accepts the right code in any grouping or case', () => {
    for (const spelling of [
      RECOVERY_CODE.toLowerCase(),
      RECOVERY_CODE.replaceAll('-', ''),
      `  ${RECOVERY_CODE.replaceAll('-', ' ')}  `,
    ]) {
      assert.equal(submitTypedCode(reachAccountCard(), spelling).kind, 'complete', `rejected ${spelling}`);
    }
  });

  it('withdraws a confirmation when the entry is edited into something wrong', () => {
    // The screen a user can actually produce: type it right, then keep typing.
    const confirmed = submitTypedCode(reachAccountCard(), RECOVERY_CODE);
    assert.equal(confirmed.kind, 'complete');

    const card = reachAccountCard();
    const acknowledged = syncSetupReducer(card, { type: 'confirmSavedToggled', checked: true });
    const edited = submitTypedCode(acknowledged, `${RECOVERY_CODE}Z`);
    assert.equal(edited.kind, 'show-account-card');
  });

  it('cannot be reached around: no other action leaves the account card', () => {
    const card = reachAccountCard();
    for (const action of [
      { type: 'detailsSubmitted' },
      { type: 'detailsRejected', message: 'nope' },
      { type: 'setupSucceeded', handle: 'other', recoveryCode: 'other' },
      { type: 'setupFailed', message: 'nope' },
      { type: 'finishRequested' },
      { type: 'retried' },
    ] as const) {
      assert.equal(syncSetupReducer(card, action).kind, 'show-account-card', `escaped via ${action.type}`);
    }
  });
});

describe('passphrase strength', () => {
  /** The bands the catalog is willing to render, read from the catalog itself rather than restated here. */
  const catalogKeys = Object.keys(enCommon.sync.passphrase.strength);

  /** One sample per band, chosen to sit either side of the boundaries in `passphrase-strength.ts`. */
  const samples = ['short', 'correct hors', 'correct horse battery staple'];

  it('emits exactly the keys the catalog defines, and every one of them', () => {
    const emitted = new Set(samples.map((sample) => passphraseStrengthKey(ratePassphrase(sample))));
    const expected = new Set(catalogKeys.map((band) => `sync.passphrase.strength.${band}`));
    assert.deepEqual([...emitted].toSorted(), [...expected].toSorted());
    assert.equal(expected.size, 3, 'the meter renders three bands, no more and no fewer');
  });

  it('resolves every emitted key to real copy in the shipped catalog', () => {
    // Built from the catalog's own entries, so a band renamed on either side
    // shows up as a missing lookup rather than as a silently absent string.
    const copyByBand = new Map(Object.entries(enCommon.sync.passphrase.strength));
    for (const sample of samples) {
      const key = passphraseStrengthKey(ratePassphrase(sample));
      const band = key.slice('sync.passphrase.strength.'.length);
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
   * The packages a password-and-session product needs and this one must not.
   * Accounts here are a handle plus a passphrase that never leaves the device,
   * so a route reaching for a password hasher or a form-auth strategy means
   * the deleted login screens have grown back somewhere.
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
    assert.deepEqual(hits, [], `route files must not import ${FORBIDDEN_PACKAGES.join(', ')}:\n${hits.join('\n')}`);
  });

  it('detects a forbidden import when one is present (guards against a vacuous check)', () => {
    const pattern = new RegExp(`(?:from|import|require\\()\\s*['"]bcryptjs['"]`);
    assert.ok(pattern.test("import bcrypt from 'bcryptjs';"));
    assert.ok(pattern.test('const b = require("bcryptjs");'));
    assert.ok(!pattern.test("// bcryptjs is deliberately not imported here"));
  });
});
