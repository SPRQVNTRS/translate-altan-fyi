/**
 * COPIED, NOT SHARED. Source: openplate/tests/unit/sync-engine/dek-wrap.test.ts @ 68e893ac71d25ad7ff42280773ea0ec94f4f700e.
 * See .adr/0008-e2ee-sync-copied-not-extracted.md. Fixes belong upstream first,
 * then here. Do not let the two drift.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEK_BYTES, generateDek, unwrapDek, wrapDek } from '#app/lib/e2ee/crypto/dek-wrap';

async function testKek(): Promise<CryptoKey> {
  const raw = crypto.getRandomValues(new Uint8Array(32));
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

test('wrap/unwrap round-trips the DEK', async () => {
  const dek = generateDek();
  const kek = await testKek();
  const wrappedDek = await wrapDek({ dek, kek });
  const unwrapped = await unwrapDek({ wrappedDek, kek });
  assert.deepEqual(unwrapped, dek);
});

test('unwrapping with the WRONG kek fails', async () => {
  const dek = generateDek();
  const kek = await testKek();
  const wrongKek = await testKek();
  const wrappedDek = await wrapDek({ dek, kek });
  await assert.rejects(() => unwrapDek({ wrappedDek, kek: wrongKek }));
});

test('generateDek returns a fresh 32-byte value each call', () => {
  const a = generateDek();
  const b = generateDek();
  assert.equal(a.byteLength, DEK_BYTES);
  assert.notDeepEqual(a, b);
});

test('wrapDek returns a SINGLE packed blob (IV prepended) — security review finding #1', async () => {
  const dek = generateDek();
  const kek = await testKek();
  const wrappedDek = await wrapDek({ dek, kek });
  // AES_GCM_IV_BYTES (12) + DEK_BYTES (32) + the 16-byte GCM auth tag WebCrypto appends to the ciphertext.
  assert.equal(wrappedDek.byteLength, 12 + DEK_BYTES + 16);
});

test('a wrapped DEK survives a base64 round trip (serialize -> DB-shape -> parse) unchanged', async () => {
  // Proves the exact shape that crosses the wire (`register-routes.ts` base64-encodes
  // `wrappedDek` for JSON) and lands in Postgres (`sync_key_records.wrapped_dek` bytea)
  // round-trips byte-for-byte, so the packed IV genuinely survives storage/transport.
  const dek = generateDek();
  const kek = await testKek();
  const wrappedDek = await wrapDek({ dek, kek });

  const wireBase64 = Buffer.from(wrappedDek).toString('base64');
  const rehydrated = new Uint8Array(Buffer.from(wireBase64, 'base64'));
  assert.deepEqual(rehydrated, wrappedDek);

  const unwrapped = await unwrapDek({ wrappedDek: rehydrated, kek });
  assert.deepEqual(unwrapped, dek);
});
