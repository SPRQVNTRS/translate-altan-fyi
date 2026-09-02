/**
 * COPIED, NOT SHARED. Source: openplate/tests/unit/sync-engine/passphrase-kek.test.ts @ 68e893ac71d25ad7ff42280773ea0ec94f4f700e.
 * See .adr/0008-e2ee-sync-copied-not-extracted.md. Fixes belong upstream first,
 * then here. Do not let the two drift.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPassphraseKdfDescriptor, derivePassphraseKek } from '#app/lib/e2ee/client/passphrase-kek';
import {
  deriveArgon2idHash,
  generateArgon2idSalt,
  type Argon2idParams,
} from '#app/lib/e2ee/crypto/argon2';
import { aesGcmDecrypt, aesGcmEncrypt } from '#app/lib/e2ee/crypto/aes-gcm';

const FAST_TEST_PARAMS: Argon2idParams = { memorySizeKib: 8, iterations: 1, parallelism: 1 };

test('createPassphraseKdfDescriptor round-trips the salt (base64) and carries the params', () => {
  const salt = generateArgon2idSalt();
  const descriptor = createPassphraseKdfDescriptor(salt, FAST_TEST_PARAMS);
  assert.deepEqual(descriptor.params, FAST_TEST_PARAMS);
  assert.ok(descriptor.salt.length > 0, 'the descriptor must carry the base64 salt');
});

test('the full passphrase chain (Argon2id -> HKDF) derives a usable, deterministic KEK', async () => {
  const salt = generateArgon2idSalt();
  const descriptor = createPassphraseKdfDescriptor(salt, FAST_TEST_PARAMS);
  const passphrase = 'correct horse battery staple';

  const hashA = await deriveArgon2idHash({ passphrase, salt, params: FAST_TEST_PARAMS });
  const kekA = await derivePassphraseKek({ argon2idHash: hashA, descriptor });

  // Simulates a NEW DEVICE re-deriving the same KEK from the stored descriptor (D2's bootstrap flow).
  const hashB = await deriveArgon2idHash({ passphrase, salt, params: descriptor.params });
  const kekB = await derivePassphraseKek({ argon2idHash: hashB, descriptor });

  const plaintext = new TextEncoder().encode('bootstrap on a new device');
  const { iv, ciphertext } = await aesGcmEncrypt({ key: kekA, plaintext });
  const decrypted = await aesGcmDecrypt({ key: kekB, iv, ciphertext });
  assert.deepEqual(decrypted, plaintext);
});

test('a wrong passphrase derives a KEK that cannot decrypt', async () => {
  const salt = generateArgon2idSalt();
  const descriptor = createPassphraseKdfDescriptor(salt, FAST_TEST_PARAMS);

  const rightHash = await deriveArgon2idHash({ passphrase: 'right passphrase', salt, params: FAST_TEST_PARAMS });
  const rightKek = await derivePassphraseKek({ argon2idHash: rightHash, descriptor });

  const wrongHash = await deriveArgon2idHash({ passphrase: 'wrong passphrase', salt, params: FAST_TEST_PARAMS });
  const wrongKek = await derivePassphraseKek({ argon2idHash: wrongHash, descriptor });

  const plaintext = new TextEncoder().encode('should not decrypt');
  const { iv, ciphertext } = await aesGcmEncrypt({ key: rightKek, plaintext });
  await assert.rejects(() => aesGcmDecrypt({ key: wrongKek, iv, ciphertext }));
});
