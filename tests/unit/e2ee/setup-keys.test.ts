/**
 * COPIED, NOT SHARED. Source: openplate/tests/unit/sync-engine/setup-keys.test.ts @ 68e893ac71d25ad7ff42280773ea0ec94f4f700e.
 * See .adr/0008-e2ee-sync-copied-not-extracted.md. Fixes belong upstream first,
 * then here. Do not let the two drift.
 */
/**
 * Covers `setupSyncKeys` — the composite that produces both wrapped-DEK key
 * records for a first-time sync setup (M128 spec 01).
 *
 * Argon2id is injected with TINY parameters throughout. The production
 * parameters are memory-hard on purpose (64 MiB, 3 iterations) and would make
 * this suite slow without proving anything the fast path doesn't: what is
 * being tested here is the WIRING — one DEK wrapped under two independent
 * KEKs, the descriptor recorded faithfully enough for another device to
 * re-derive, and no key material leaking into the result.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setupSyncKeys } from '#app/lib/e2ee/client/setup-keys';
import { deriveArgon2idHash, type Argon2idParams } from '#app/lib/e2ee/crypto/argon2';
import { unwrapDek } from '#app/lib/e2ee/crypto/dek-wrap';
import { derivePassphraseKek, type PassphraseKdfDescriptor } from '#app/lib/e2ee/client/passphrase-kek';
import { deriveRecoveryKek, generateRecoveryCode } from '#app/lib/e2ee/client/recovery-kek';

const FAST_TEST_PARAMS: Argon2idParams = { memorySizeKib: 8, iterations: 1, parallelism: 1 };

async function runSetup(passphrase: string, recoveryCodeRaw: Uint8Array) {
  return setupSyncKeys({ passphrase, recoveryCodeRaw, params: FAST_TEST_PARAMS });
}

type SetupResult = Awaited<ReturnType<typeof runSetup>>;

/** The passphrase record's descriptor, read back as the type that produced it. */
function passphraseDescriptorOf(result: SetupResult): PassphraseKdfDescriptor {
  assert.notEqual(result.passphraseKeyRecord.kdfDescriptor, null, 'setup must write a passphrase KDF descriptor');
  // SAFETY: `setupSyncKeys` fills this field with `createPassphraseKdfDescriptor`.
  // The wire type stays open only because the service never reads inside it.
  return result.passphraseKeyRecord.kdfDescriptor as PassphraseKdfDescriptor;
}

test('both key records unwrap to the SAME DEK — one secret, two doors', async () => {
  const recoveryCode = generateRecoveryCode();
  const result = await runSetup('correct horse battery staple', recoveryCode.raw);

  const descriptor = passphraseDescriptorOf(result);
  const argon2idHash = await deriveArgon2idHash({
    passphrase: 'correct horse battery staple',
    salt: base64ToBytes(descriptor.salt),
    params: descriptor.params,
  });
  const passphraseKek = await derivePassphraseKek({ argon2idHash, descriptor });
  const recoveryKek = await deriveRecoveryKek(recoveryCode.raw);

  const viaPassphrase = await unwrapDek({ wrappedDek: result.passphraseKeyRecord.wrappedDek, kek: passphraseKek });
  const viaRecovery = await unwrapDek({ wrappedDek: result.recoveryKeyRecord.wrappedDek, kek: recoveryKek });

  assert.deepEqual(viaPassphrase, viaRecovery);
  assert.equal(viaPassphrase.byteLength, 32);
});

test('the passphrase record carries a KDF descriptor and the recovery record never does', async () => {
  const result = await runSetup('a-long-enough-passphrase', generateRecoveryCode().raw);

  assert.notEqual(result.passphraseKeyRecord.kdfDescriptor, null);
  // Always null for the recovery kind — the service rejects a recovery record that carries one.
  assert.equal(result.recoveryKeyRecord.kdfDescriptor, null);
});

test('the descriptor records the exact parameters used, so another device can re-derive', async () => {
  const result = await runSetup('a-long-enough-passphrase', generateRecoveryCode().raw);
  const descriptor = passphraseDescriptorOf(result);

  assert.deepEqual(descriptor.params, FAST_TEST_PARAMS);
  assert.ok(descriptor.salt.length > 0, 'the descriptor must carry the base64 salt');
});

test('two setups with the SAME passphrase produce different salts and different wrapped DEKs', async () => {
  const first = await runSetup('identical passphrase', generateRecoveryCode().raw);
  const second = await runSetup('identical passphrase', generateRecoveryCode().raw);

  const firstSalt = passphraseDescriptorOf(first).salt;
  const secondSalt = passphraseDescriptorOf(second).salt;
  assert.notEqual(firstSalt, secondSalt);
  assert.notDeepEqual(first.passphraseKeyRecord.wrappedDek, second.passphraseKeyRecord.wrappedDek);
});

test('the wrong recovery code cannot unwrap the recovery record', async () => {
  const result = await runSetup('a-long-enough-passphrase', generateRecoveryCode().raw);
  const wrongKek = await deriveRecoveryKek(generateRecoveryCode().raw);

  await assert.rejects(() => unwrapDek({ wrappedDek: result.recoveryKeyRecord.wrappedDek, kek: wrongKek }));
});

test('the Argon2id step is injectable — the caller decides where it runs', async () => {
  let receivedParams: Argon2idParams | null = null;
  const result = await setupSyncKeys({
    passphrase: 'a-long-enough-passphrase',
    recoveryCodeRaw: generateRecoveryCode().raw,
    params: FAST_TEST_PARAMS,
    deriveHash: async ({ params }) => {
      receivedParams = params;
      return new Uint8Array(32).fill(1);
    },
  });

  assert.deepEqual(receivedParams, FAST_TEST_PARAMS);
  assert.ok(result.passphraseKeyRecord.wrappedDek.byteLength > 0);
});

function base64ToBytes(base64: string): Uint8Array {
  return new Uint8Array(Buffer.from(base64, 'base64'));
}
