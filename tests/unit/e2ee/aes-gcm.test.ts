/**
 * COPIED, NOT SHARED. Source: openplate/tests/unit/sync-engine/aes-gcm.test.ts @ 68e893ac71d25ad7ff42280773ea0ec94f4f700e.
 * See .adr/0008-e2ee-sync-copied-not-extracted.md. Fixes belong upstream first,
 * then here. Do not let the two drift.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AES_GCM_IV_BYTES,
  aesGcmDecrypt,
  aesGcmEncrypt,
  generateIv,
  packIvAndCiphertext,
  splitIvAndCiphertext,
} from '#app/lib/e2ee/crypto/aes-gcm';

async function testKey(): Promise<CryptoKey> {
  const raw = crypto.getRandomValues(new Uint8Array(32));
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

test('encrypt/decrypt round-trips plaintext', async () => {
  const key = await testKey();
  const plaintext = new TextEncoder().encode('the quick brown fox');
  const { iv, ciphertext } = await aesGcmEncrypt({ key, plaintext });
  const decrypted = await aesGcmDecrypt({ key, iv, ciphertext });
  assert.deepEqual(decrypted, plaintext);
});

test('AAD binding: decrypting with a DIFFERENT additionalData fails', async () => {
  const key = await testKey();
  const plaintext = new TextEncoder().encode('bound to this AAD');
  const aad = new TextEncoder().encode('{"accountId":1,"blobVersion":1}');
  const { iv, ciphertext } = await aesGcmEncrypt({ key, plaintext, additionalData: aad });

  const tamperedAad = new TextEncoder().encode('{"accountId":2,"blobVersion":1}');
  await assert.rejects(() => aesGcmDecrypt({ key, iv, ciphertext, additionalData: tamperedAad }));
});

test('a tampered ciphertext byte fails decryption (GCM tag check)', async () => {
  const key = await testKey();
  const plaintext = new TextEncoder().encode('integrity matters');
  const { iv, ciphertext } = await aesGcmEncrypt({ key, plaintext });
  const tampered = new Uint8Array(ciphertext);
  tampered[0] = tampered[0] ^ 0xff;
  await assert.rejects(() => aesGcmDecrypt({ key, iv, ciphertext: tampered }));
});

test('generateIv returns a fresh 12-byte value each call', () => {
  const a = generateIv();
  const b = generateIv();
  assert.equal(a.byteLength, 12);
  assert.equal(b.byteLength, 12);
  assert.notDeepEqual(a, b);
});

test('packIvAndCiphertext/splitIvAndCiphertext round-trip (security review finding #1)', () => {
  const iv = generateIv();
  const ciphertext = new TextEncoder().encode('some ciphertext bytes + tag');
  const packed = packIvAndCiphertext(iv, ciphertext);
  assert.equal(packed.byteLength, iv.byteLength + ciphertext.byteLength);

  const split = splitIvAndCiphertext(packed);
  assert.deepEqual(split.iv, iv);
  assert.deepEqual(split.ciphertext, ciphertext);
});

test('splitIvAndCiphertext throws on a blob too short to contain a full IV', () => {
  const tooShort = new Uint8Array(AES_GCM_IV_BYTES - 1);
  assert.throws(() => splitIvAndCiphertext(tooShort), /too short/);
});

test('a full encrypt -> pack -> split -> decrypt round trip works end to end', async () => {
  const key = await testKey();
  const plaintext = new TextEncoder().encode('packed round trip');
  const { iv, ciphertext } = await aesGcmEncrypt({ key, plaintext });
  const packed = packIvAndCiphertext(iv, ciphertext);
  const split = splitIvAndCiphertext(packed);
  const decrypted = await aesGcmDecrypt({ key, iv: split.iv, ciphertext: split.ciphertext });
  assert.deepEqual(decrypted, plaintext);
});
