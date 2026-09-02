/**
 * COPIED, NOT SHARED. Source: openplate/tests/unit/sync-engine/hkdf.test.ts @ 68e893ac71d25ad7ff42280773ea0ec94f4f700e.
 * See .adr/0008-e2ee-sync-copied-not-extracted.md. Fixes belong upstream first,
 * then here. Do not let the two drift.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveAesKeyViaHkdf, HKDF_INFO } from '#app/lib/e2ee/crypto/hkdf';
import { aesGcmDecrypt, aesGcmEncrypt } from '#app/lib/e2ee/crypto/aes-gcm';
import { deriveRecoveryAuthHash, deriveRecoveryKek } from '#app/lib/e2ee/client/recovery-kek';
import { base64ToBytes } from '#app/lib/e2ee/crypto/base64';
import { toBufferSource } from '#app/lib/e2ee/crypto/buffer-source';

const IKM = new TextEncoder().encode('input-key-material-32-bytes-long!!');
const SALT = new Uint8Array(16).fill(7);

test('deriveAesKeyViaHkdf produces a usable AES-GCM key (round-trips encrypt/decrypt)', async () => {
  const key = await deriveAesKeyViaHkdf({ inputKeyMaterial: IKM, salt: SALT, info: HKDF_INFO.PASSPHRASE_KEK });
  const plaintext = new TextEncoder().encode('hello sync');
  const { iv, ciphertext } = await aesGcmEncrypt({ key, plaintext });
  const decrypted = await aesGcmDecrypt({ key, iv, ciphertext });
  assert.deepEqual(decrypted, plaintext);
});

test('deriveAesKeyViaHkdf is deterministic for the same (ikm, salt, info)', async () => {
  const keyA = await deriveAesKeyViaHkdf({ inputKeyMaterial: IKM, salt: SALT, info: HKDF_INFO.PASSPHRASE_KEK });
  const keyB = await deriveAesKeyViaHkdf({ inputKeyMaterial: IKM, salt: SALT, info: HKDF_INFO.PASSPHRASE_KEK });

  // CryptoKey objects aren't directly comparable, so prove equality via
  // behavior: a key derived by A must decrypt what B encrypted.
  const plaintext = new TextEncoder().encode('determinism check');
  const { iv, ciphertext } = await aesGcmEncrypt({ key: keyB, plaintext });
  const decrypted = await aesGcmDecrypt({ key: keyA, iv, ciphertext });
  assert.deepEqual(decrypted, plaintext);
});

test('a different salt derives a DIFFERENT key (decryption fails across them)', async () => {
  const keyA = await deriveAesKeyViaHkdf({ inputKeyMaterial: IKM, salt: SALT, info: HKDF_INFO.PASSPHRASE_KEK });
  const differentSalt = new Uint8Array(16).fill(9);
  const keyB = await deriveAesKeyViaHkdf({
    inputKeyMaterial: IKM,
    salt: differentSalt,
    info: HKDF_INFO.PASSPHRASE_KEK,
  });

  const plaintext = new TextEncoder().encode('should not decrypt');
  const { iv, ciphertext } = await aesGcmEncrypt({ key: keyA, plaintext });
  await assert.rejects(() => aesGcmDecrypt({ key: keyB, iv, ciphertext }));
});

test('PASSPHRASE_KEK and RECOVERY_KEK derive DIFFERENT keys from the SAME (ikm, salt) — domain separation (security review finding #7)', async () => {
  const passphraseKek = await deriveAesKeyViaHkdf({
    inputKeyMaterial: IKM,
    salt: SALT,
    info: HKDF_INFO.PASSPHRASE_KEK,
  });
  const recoveryKek = await deriveAesKeyViaHkdf({ inputKeyMaterial: IKM, salt: SALT, info: HKDF_INFO.RECOVERY_KEK });

  const plaintext = new TextEncoder().encode('must not cross domains');
  const { iv, ciphertext } = await aesGcmEncrypt({ key: passphraseKek, plaintext });
  await assert.rejects(() => aesGcmDecrypt({ key: recoveryKek, iv, ciphertext }));
});

test('HKDF_INFO.PASSPHRASE_KEK and HKDF_INFO.RECOVERY_KEK are distinct byte labels', () => {
  assert.notDeepEqual(HKDF_INFO.PASSPHRASE_KEK, HKDF_INFO.RECOVERY_KEK);
});

test('every HKDF label is DISTINCT — the domain-separation guard, in code rather than in a grep', () => {
  // The spec's shell guard for this matches `'openplate-sync:<letters>:v1'`,
  // which the share label (`...:share-kek:p256:v1`) does not fit — its curve
  // segment carries digits. So the real check lives here, where it sees every
  // label whatever its shape. Two labels sharing a value is the exact defect
  // security review finding #7 recorded, and it fails SILENTLY: the wrong
  // branch authenticates fine and produces a key that decrypts nothing.
  const labels = Object.values(HKDF_INFO).map((info) => new TextDecoder().decode(info));
  assert.equal(new Set(labels).size, labels.length);
  assert.deepEqual(labels.toSorted(), [
    'openplate-sync:auth:v1',
    'openplate-sync:passphrase-kek:v1',
    'openplate-sync:private-store-kek:v1',
    'openplate-sync:private-store-recovery-kek:v1',
    'openplate-sync:recovery-auth:v1',
    'openplate-sync:recovery-kek:v1',
    'openplate-sync:research-kek:p256:v1',
    'openplate-sync:share-kek:p256:v1',
  ]);
});

test('RECOVERY_AUTH is the frozen literal openplate-sync:recovery-auth:v1', () => {
  // Its BYTES, not its name. A rename would derive an entirely different
  // proof and lock every account out of recovery, and the failure would be
  // invisible until a user with a lost passphrase actually needed it.
  assert.equal(new TextDecoder().decode(HKDF_INFO.RECOVERY_AUTH), 'openplate-sync:recovery-auth:v1');
  assert.notDeepEqual(HKDF_INFO.RECOVERY_AUTH, HKDF_INFO.RECOVERY_KEK);
});

test('the recovery AUTH proof is not the recovery KEK — the value sent cannot open the wrap', async () => {
  // THE SECURITY CORE OF M181 spec 02, asserted rather than asserted-about.
  // Both derive from the SAME raw recovery code with the same (empty) salt,
  // so only the label separates them. If it ever stopped doing so, the server
  // would be storing an HMAC of the material that unwraps the DEK.
  const rawCode = new Uint8Array(20).fill(3);

  const kek = await deriveRecoveryKek(rawCode);
  const plaintext = new TextEncoder().encode('the wrapped DEK');
  const { iv, ciphertext } = await aesGcmEncrypt({ key: kek, plaintext });

  const authHash = base64ToBytes(await deriveRecoveryAuthHash(rawCode));
  assert.equal(authHash.byteLength, 32);

  // Import the proof AS an AES key and try it on the wrap. If the two
  // derivations ever collapsed onto one label this would decrypt, which is
  // the whole failure being ruled out.
  const proofAsKey = await crypto.subtle.importKey('raw', toBufferSource(authHash), 'AES-GCM', false, ['decrypt']);
  await assert.rejects(() => aesGcmDecrypt({ key: proofAsKey, iv, ciphertext }));
});
