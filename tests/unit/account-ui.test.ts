/**
 * The account screens' load-bearing rules, tested where they live rather than
 * through a rendered DOM.
 *
 * There is no DOM library in this repo and none is added here: everything
 * below is pure logic that the components merely call. That is the point of
 * the split. The save gate in particular is a security rule, so it lives in
 * the reducer where a test can drive it, not in an event handler where only
 * review could ever have caught a regression.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildKeyRecordRequest,
  buildSignupRequest,
  kdfResponseSchema,
  keyRecordResponseSchema,
  keyRecordsResponseSchema,
  sessionSchema,
} from '#app/components/account/sync-client';
import { SyncRequestError, errorKindForStatus } from '#app/lib/e2ee/client/sync-error';
import { classifySignInFailure } from '#app/lib/e2ee/flows/sign-in-error';
import { formatRecoveryCode } from '#app/lib/e2ee/client/recovery-kek';
import { passphraseStrengthKey, ratePassphrase } from '#app/lib/e2ee/flows/password-strength';
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

describe('recovery-code save gate', () => {
  it('does not complete while the save has not been confirmed', () => {
    const card = reachAccountCard();
    assert.equal(syncSetupReducer(card, { type: 'finishRequested' }).kind, 'show-account-card');
  });

  it('completes once the checkbox is ticked', () => {
    const acknowledged = syncSetupReducer(reachAccountCard(), { type: 'confirmSavedToggled', checked: true });
    assert.equal(syncSetupReducer(acknowledged, { type: 'finishRequested' }).kind, 'complete');
  });

  it('withdraws the confirmation when the checkbox is unticked again', () => {
    // The screen a user can actually produce: tick it, think again, untick it.
    let state = syncSetupReducer(reachAccountCard(), { type: 'confirmSavedToggled', checked: true });
    state = syncSetupReducer(state, { type: 'confirmSavedToggled', checked: false });
    assert.equal(syncSetupReducer(state, { type: 'finishRequested' }).kind, 'show-account-card');
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

/**
 * WIRE-CONTRACT TESTS. `PROTOCOL.md` is the source, and the TypeScript is its
 * transcription rather than the other way round, so every literal below is
 * COPIED OUT OF THE DOCUMENT and then parsed with the client's real schema.
 *
 * ── Why this suite exists ────────────────────────────────────────────────
 *
 * `fetchKdfDescriptor` read the bare descriptor while section 5.7 specifies an
 * envelope. The whole gate was green over it: lint, typecheck, every unit
 * test, the integration suite and the production build all passed, because
 * nothing anywhere compared a client schema against what a route actually
 * returns. The integration tests exercise the store, and the rest of this file
 * tests pure logic. Second-device sign in was simply impossible, and it took a
 * browser on a real deployment to find out.
 *
 * ── Why the literals are transcribed and not generated ───────────────────
 *
 * A fixture built from the schema, or from a handler's return type, only ever
 * proves the schema agrees with itself. Typing the document's own JSON in by
 * hand is what makes this a test of the CONTRACT. If the protocol changes, the
 * fix is to retranscribe the literal, never to relax the schema.
 *
 * Each case is paired with a NEGATIVE one asserting the shape the client used
 * to expect is now REJECTED, so this suite would have failed on the original
 * defect instead of passing beside it.
 */
describe('wire contract: PROTOCOL.md is the source', () => {
  describe('POST /v1/auth/kdf (section 5.7)', () => {
    // Transcribed from section 5.7. The document writes the salt as the
    // placeholder "<base64, 16 bytes>"; a real 16-byte base64 value stands in
    // for it, because a placeholder cannot be decoded. The envelope, the field
    // names and the three parameter values are the document's own.
    const documented = {
      kdfDescriptor: {
        salt: 'AAECAwQFBgcICQoLDA0ODw==',
        params: { memorySizeKib: 65536, iterations: 3, parallelism: 1 },
      },
    };

    it('accepts the documented response and yields the descriptor', () => {
      const parsed = kdfResponseSchema.safeParse(documented);
      assert.ok(parsed.success, 'the documented 200 body must parse');
      assert.equal(parsed.data.kdfDescriptor.salt, 'AAECAwQFBgcICQoLDA0ODw==');
      assert.equal(parsed.data.kdfDescriptor.params.memorySizeKib, 65536);
    });

    it('rejects a BARE descriptor, the shape that broke second-device sign in', () => {
      const bare = documented.kdfDescriptor;
      assert.equal(kdfResponseSchema.safeParse(bare).success, false);
    });

    it('rejects a descriptor with a missing or non-positive parameter', () => {
      const noParams = { kdfDescriptor: { salt: 'AAECAwQFBgcICQoLDA0ODw==' } };
      const zeroIterations = {
        kdfDescriptor: { salt: 'AAECAwQFBgcICQoLDA0ODw==', params: { memorySizeKib: 65536, iterations: 0, parallelism: 1 } },
      };
      assert.equal(kdfResponseSchema.safeParse(noParams).success, false);
      assert.equal(kdfResponseSchema.safeParse(zeroIterations).success, false);
    });
  });

  describe('POST /v1/auth/signup and /v1/auth/login (sections 5.8 and 5.9)', () => {
    // Section 5.8's 201 row, verbatim: {"account": {"id": 1, "handle": "...",
    // "displayName": null}, "tokens": {...}}. Section 5.9 gives login the same
    // shape. `tokens` is present here exactly as the service sends it, to prove
    // the client tolerates a field it deliberately does not model: the session
    // rides an httpOnly cookie and no code in the browser may hold a token.
    const documented = {
      account: { id: 1, handle: 'qr7k4m2p', displayName: null },
      tokens: { accessToken: 'opaque', refreshToken: 'opaque', expiresAt: '2026-01-01T00:00:00.000Z' },
    };

    it('accepts the documented session response from either endpoint', () => {
      const parsed = sessionSchema.safeParse(documented);
      assert.ok(parsed.success, 'the documented session body must parse');
      assert.equal(parsed.data.account.handle, 'qr7k4m2p');
      assert.equal(parsed.data.account.id, 1);
    });

    it('rejects a session response with no account', () => {
      assert.equal(sessionSchema.safeParse({ tokens: documented.tokens }).success, false);
      assert.equal(sessionSchema.safeParse({ account: { handle: 'qr7k4m2p' } }).success, false);
    });
  });

  /**
   * WHAT THESE TWO PROTECT: the envelope around a key record, which is what
   * carries the wrapped DEK. Section 5.3 lists the records under `records`,
   * and section 5.4 answers with the stored record BARE.
   *
   * THE DEFECT THEY CATCH: the port shipped `{"keyRecords": [...]}` and
   * `{"keyRecord": {...}}`, because the client schemas were transcribed from
   * this repo's own route instead of from the document. Both sides agreed with
   * each other and disagreed with `PROTOCOL.md`, so the whole gate was green
   * over an account that could sign in and never unwrap its DEK. It was fixed
   * in `14bf27f`; until these cases existed, nothing would have caught it
   * coming back.
   *
   * Each case pairs the documented literal with the wrapper the port used, so
   * a schema loose enough to ignore the envelope fails the negative half
   * instead of passing both.
   */
  describe('GET /key-records (section 5.3)', () => {
    // Transcribed from section 5.3's example body: the `records` envelope and
    // both entries, including the `recovery` entry's `kdfDescriptor: null`
    // exactly as the document writes it. `<base64>` and `<iso>` stand in as
    // real values, because a placeholder cannot be decoded or parsed.
    const documented = {
      records: [
        {
          kind: 'passphrase',
          kdfDescriptor: {
            salt: 'AAECAwQFBgcICQoLDA0ODw==',
            params: { memorySizeKib: 65536, iterations: 3, parallelism: 1 },
          },
          wrappedDek: 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGw==',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
        { kind: 'recovery', kdfDescriptor: null, wrappedDek: 'HB0eHyAhIiMkJSYnKCkqKywtLi8wMTIz', updatedAt: '2026-01-02T00:00:00.000Z' },
      ],
    };

    it('accepts the documented list, recovery record and its null descriptor included', () => {
      const parsed = keyRecordsResponseSchema.safeParse(documented);
      assert.ok(parsed.success, 'the documented 200 body must parse');
      // BOTH records must survive. The recovery path is HKDF-only and so has
      // no descriptor to record; a schema that rejected the null would drop
      // every account's second authenticator, which is the one a second device
      // and every lost-passphrase recovery goes through.
      assert.deepEqual(
        parsed.data.records.map((record) => record.kind),
        ['passphrase', 'recovery'],
      );
      assert.equal(parsed.data.records[1]?.wrappedDek, 'HB0eHyAhIiMkJSYnKCkqKywtLi8wMTIz');
    });

    it('rejects the array under a keyRecords key, the envelope the port shipped', () => {
      const asThePortAnswered = { keyRecords: documented.records };
      assert.equal(keyRecordsResponseSchema.safeParse(asThePortAnswered).success, false);
    });
  });

  describe('PUT /key-records/:kind 200 (section 5.4)', () => {
    // Section 5.4 says the 200 body is "the stored record, same shape as a
    // `GET /key-records` entry" — so this is section 5.3's first entry, BARE,
    // with no wrapper key around it.
    const documented = {
      kind: 'passphrase',
      kdfDescriptor: {
        salt: 'AAECAwQFBgcICQoLDA0ODw==',
        params: { memorySizeKib: 65536, iterations: 3, parallelism: 1 },
      },
      wrappedDek: 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGw==',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };

    it('accepts the stored record bare', () => {
      const parsed = keyRecordResponseSchema.safeParse(documented);
      assert.ok(parsed.success, 'the documented 200 body must parse');
      assert.equal(parsed.data.kind, 'passphrase');
      assert.equal(parsed.data.updatedAt, '2026-01-01T00:00:00.000Z');
    });

    it('rejects the record wrapped under a keyRecord key, the shape the port shipped', () => {
      const asThePortAnswered = { keyRecord: documented };
      assert.equal(keyRecordResponseSchema.safeParse(asThePortAnswered).success, false);
    });
  });
});

describe('wire contract: what setup SENDS', () => {
  const kdfDescriptor = {
    salt: 'AAECAwQFBgcICQoLDA0ODw==',
    params: { memorySizeKib: 65536, iterations: 3, parallelism: 1 },
  };

  describe('POST /v1/auth/signup body (section 5.8)', () => {
    /**
     * Section 5.8's request block, transcribed field for field. This list is
     * the WHOLE contract: a body key outside it is a key the service does not
     * read.
     */
    const DOCUMENTED_FIELDS = new Set(['handle', 'authHash', 'kdfDescriptor', 'displayName', 'recoveryAuthHash']);

    const body = buildSignupRequest({
      handle: 'qr7k4m2p',
      authHash: 'YXV0aC1oYXNo',
      recoveryAuthHash: 'cmVjb3ZlcnktYXV0aC1oYXNo',
      kdfDescriptor,
    });

    /**
     * THE TEST THAT WOULD HAVE CAUGHT THE UNOPENABLE ACCOUNT.
     *
     * The body carried a `keyRecords` array, which section 5.8 does not
     * define. The service ignored it and returned `201`, so every account
     * created had a verifier and a session but no wrapped DEK anywhere: it
     * could log in and could never decrypt. Sending a field a server does not
     * read is invisible from the client, which is why the assertion has to be
     * against the DOCUMENT rather than against a response.
     */
    it('sends no field PROTOCOL.md does not define', () => {
      const undocumented = Object.keys(body).filter((field) => !DOCUMENTED_FIELDS.has(field));
      assert.deepEqual(undocumented, [], `undocumented signup fields: ${undocumented.join(', ')}`);
    });

    it('sends every field the service needs to build a usable account', () => {
      // `displayName` is the one documented field this product omits: it is
      // optional and there is no display name to send.
      for (const field of ['handle', 'authHash', 'kdfDescriptor', 'recoveryAuthHash']) {
        assert.ok(field in body, `signup body is missing ${field}`);
      }
    });

    it('detects an undocumented field, so the check above is not vacuous', () => {
      const contaminated = { ...body, keyRecords: [] };
      const undocumented = Object.keys(contaminated).filter((field) => !DOCUMENTED_FIELDS.has(field));
      assert.deepEqual(undocumented, ['keyRecords']);
    });
  });

  describe('PUT /key-records body (section 5.4)', () => {
    const wrappedDek = Uint8Array.from({ length: 28 }, (_, index) => index);

    it('asserts no record exists yet, with the CAS key PRESENT and null', () => {
      const body = buildKeyRecordRequest({
        kind: 'passphrase',
        record: { kdfDescriptor, wrappedDek },
      });
      // Present AND null. The route rejects a body that merely omits the key,
      // so `in` is the assertion that matters here, not the value alone.
      assert.ok('expectedUpdatedAt' in body, 'expectedUpdatedAt must be present');
      assert.equal(body.expectedUpdatedAt, null);
      assert.equal(body.wrappedDek, 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGw==');
    });

    it('carries the descriptor for a passphrase record and null for a recovery one', () => {
      // Either mistake is a 400: the passphrase path needs the parameters to
      // re-derive its KEK, and the recovery path is HKDF-only so it has none.
      const passphraseBody = buildKeyRecordRequest({ kind: 'passphrase', record: { kdfDescriptor, wrappedDek } });
      const recoveryBody = buildKeyRecordRequest({ kind: 'recovery', record: { kdfDescriptor: null, wrappedDek } });
      assert.deepEqual(passphraseBody.kdfDescriptor, kdfDescriptor);
      assert.equal(recoveryBody.kdfDescriptor, null);
    });
  });
});

/**
 * The sign-in failure mapping, which the envelope defect had made unreachable:
 * the parse threw before any 401 could be seen, so a wrong passphrase rendered
 * the generic crash message instead of "Incorrect handle or passphrase."
 */
/** Exactly what `requestJson` builds from a non-2xx response. */
function requestErrorForStatus(status: number): SyncRequestError {
  return new SyncRequestError({
    kind: errorKindForStatus(status),
    // The service's single generic message (`auth-handlers.ts`'s LOGIN_REJECTED).
    message: 'invalid handle or passphrase',
    status,
  });
}

describe('sign-in failure mapping', () => {
  it('maps a 401 to rejected, which the form renders as account.signInFailed', () => {
    assert.equal(classifySignInFailure(requestErrorForStatus(401)), 'rejected');
  });

  it('cannot tell a wrong passphrase from an unknown handle', () => {
    // The service answers ONE 401, after identical work, for both. The client
    // sees only the status, so the two are the same value here BY
    // CONSTRUCTION: there is no branch that could leak which one it was, and
    // adding one would rebuild the account-enumeration oracle the protocol
    // removes.
    const wrongPassphrase = classifySignInFailure(requestErrorForStatus(401));
    const unknownHandle = classifySignInFailure(requestErrorForStatus(401));
    assert.equal(wrongPassphrase, unknownHandle);
    assert.equal(wrongPassphrase, 'rejected');
  });

  it('maps everything else to other, which renders the generic message', () => {
    for (const status of [400, 403, 429, 500]) {
      assert.equal(classifySignInFailure(requestErrorForStatus(status)), 'other', `status ${status}`);
    }
    // A schema mismatch, the original defect, arrives as a transport error and
    // must NOT be dressed up as a rejected credential.
    const parseFailure = new SyncRequestError({ kind: 'transport', message: 'unreadable shape' });
    assert.equal(classifySignInFailure(parseFailure), 'other');
    assert.equal(classifySignInFailure(new Error('boom')), 'other');
  });
});
