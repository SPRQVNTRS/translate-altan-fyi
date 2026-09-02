/**
 * COPIED, NOT SHARED. Source: openplate/tests/unit/sync-engine/argon2.test.ts @ 68e893ac71d25ad7ff42280773ea0ec94f4f700e.
 * See .adr/0008-e2ee-sync-copied-not-extracted.md. Fixes belong upstream first,
 * then here. Do not let the two drift.
 */
/**
 * Argon2id tests use TINY parameters (not `ARGON2ID_DEFAULT_PARAMS`) — the
 * default params are deliberately memory-hard/slow (D1's whole point), which
 * would make this suite slow without testing anything the tiny-param case
 * doesn't already prove (determinism, salt-sensitivity, custom-params support).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ARGON2ID_SALT_BYTES,
  deriveArgon2idHash,
  generateArgon2idSalt,
  type Argon2idParams,
} from '#app/lib/e2ee/crypto/argon2';

const FAST_TEST_PARAMS: Argon2idParams = { memorySizeKib: 8, iterations: 1, parallelism: 1 };

test('deriveArgon2idHash is deterministic for the same (passphrase, salt, params)', async () => {
  const salt = new Uint8Array(ARGON2ID_SALT_BYTES).fill(3);
  const hashA = await deriveArgon2idHash({
    passphrase: 'correct horse battery staple',
    salt,
    params: FAST_TEST_PARAMS,
  });
  const hashB = await deriveArgon2idHash({
    passphrase: 'correct horse battery staple',
    salt,
    params: FAST_TEST_PARAMS,
  });
  assert.deepEqual(hashA, hashB);
});

test('a different passphrase produces a different hash', async () => {
  const salt = new Uint8Array(ARGON2ID_SALT_BYTES).fill(3);
  const hashA = await deriveArgon2idHash({ passphrase: 'passphrase one', salt, params: FAST_TEST_PARAMS });
  const hashB = await deriveArgon2idHash({ passphrase: 'passphrase two', salt, params: FAST_TEST_PARAMS });
  assert.notDeepEqual(hashA, hashB);
});

test('a different salt produces a different hash for the SAME passphrase', async () => {
  const saltA = new Uint8Array(ARGON2ID_SALT_BYTES).fill(1);
  const saltB = new Uint8Array(ARGON2ID_SALT_BYTES).fill(2);
  const hashA = await deriveArgon2idHash({ passphrase: 'same passphrase', salt: saltA, params: FAST_TEST_PARAMS });
  const hashB = await deriveArgon2idHash({ passphrase: 'same passphrase', salt: saltB, params: FAST_TEST_PARAMS });
  assert.notDeepEqual(hashA, hashB);
});

test('generateArgon2idSalt returns a fresh 16-byte value each call', () => {
  const a = generateArgon2idSalt();
  const b = generateArgon2idSalt();
  assert.equal(a.byteLength, ARGON2ID_SALT_BYTES);
  assert.notDeepEqual(a, b);
});
