/**
 * COPIED, NOT SHARED. Source: openplate/tests/unit/sync-engine/webcrypto-inputs.test.ts @ 68e893ac71d25ad7ff42280773ea0ec94f4f700e.
 * See .adr/0008-e2ee-sync-copied-not-extracted.md. Fixes belong upstream first,
 * then here. Do not let the two drift.
 */
/**
 * What this engine actually hands to WebCrypto.
 *
 * ── The two production failures these guard ──────────────────────────────
 *
 * Both were found by a real browser against a real production server, after
 * typecheck, lint, the whole unit suite, the integration suite and the
 * production build were green. Both are about the SHAPE of an argument, which
 * no type system checks and which Node's WebCrypto is laxer about than
 * Chrome's:
 *
 *  1. **`additionalData: undefined`.** Chrome checks whether the property
 *     EXISTS before checking its type, so a key present with the value
 *     `undefined` is read as "an AAD was supplied" and rejected with
 *     `AeadParams: additionalData: Not a BufferSource`. Node follows the
 *     WebIDL rule that an undefined dictionary member is absent, and accepts
 *     it — verified directly, which is why the assertion below is on the
 *     ALGORITHM OBJECT rather than on a thrown error. Node cannot be made to
 *     fail here; the object can be inspected.
 *
 *  2. **Views over exotic buffers.** NOT the trigger for the live bug —
 *     `hash-wasm@4.11.0` was measured and returns a clean standalone array —
 *     but a latent one, because the old `bytes.buffer.slice(...)` conversion
 *     PRESERVED the buffer kind: a view over a shared `WebAssembly.Memory`
 *     produced a `SharedArrayBuffer`, which WebCrypto rejects outright. A
 *     future hash-wasm bump returning a view into its own linear memory is an
 *     ordinary design choice that would trip it. Unlike case 1 this IS
 *     reproducible in Node, so these fail loudly if the copy is ever weakened
 *     back to a slice.
 *
 * The interception below asserts against the platform boundary itself rather
 * than against `buildAesGcmParams`, which is private: what matters is what
 * `crypto.subtle` receives, because that is precisely what Chrome inspects.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toBufferSource } from '#app/lib/e2ee/crypto/buffer-source';
import { aesGcmDecrypt, aesGcmEncrypt } from '#app/lib/e2ee/crypto/aes-gcm';
import { generateDek, unwrapDek, wrapDek } from '#app/lib/e2ee/crypto/dek-wrap';
import { deriveAesKeyViaHkdf, HKDF_INFO } from '#app/lib/e2ee/crypto/hkdf';

/** A 32-byte view at a NONZERO offset inside a real `WebAssembly.Memory` — hash-wasm's actual output shape. */
function wasmMemoryView({ shared }: { shared: boolean }): Uint8Array {
  const memory =
    shared ? new WebAssembly.Memory({ initial: 1, maximum: 2, shared: true }) : new WebAssembly.Memory({ initial: 1 });
  const view = new Uint8Array(memory.buffer, 1024, 32);
  for (let index = 0; index < view.byteLength; index += 1) view[index] = (index * 7 + 3) & 0xff;
  return view;
}

/** A view at a nonzero offset inside a larger plain buffer — the structured-clone / sub-slice shape. */
function offsetView(): Uint8Array {
  const backing = new Uint8Array(256);
  for (let index = 0; index < backing.length; index += 1) backing[index] = index & 0xff;
  return new Uint8Array(backing.buffer, 64, 32);
}

/** Records every algorithm object and data argument that reaches `crypto.subtle.encrypt`/`decrypt`. */
async function captureSubtleCalls<T>(run: () => Promise<T>): Promise<{ result: T; calls: SubtleCall[] }> {
  const calls: SubtleCall[] = [];
  const originalEncrypt = crypto.subtle.encrypt.bind(crypto.subtle);
  const originalDecrypt = crypto.subtle.decrypt.bind(crypto.subtle);

  crypto.subtle.encrypt = (algorithm: AlgorithmIdentifier, key: CryptoKey, data: BufferSource) => {
    calls.push({ operation: 'encrypt', algorithm, data });
    return originalEncrypt(algorithm, key, data);
  };
  crypto.subtle.decrypt = (algorithm: AlgorithmIdentifier, key: CryptoKey, data: BufferSource) => {
    calls.push({ operation: 'decrypt', algorithm, data });
    return originalDecrypt(algorithm, key, data);
  };

  try {
    return { result: await run(), calls };
  } finally {
    crypto.subtle.encrypt = originalEncrypt;
    crypto.subtle.decrypt = originalDecrypt;
  }
}

interface SubtleCall {
  operation: 'encrypt' | 'decrypt';
  algorithm: AlgorithmIdentifier;
  data: BufferSource;
}

/**
 * A value is safe to hand to WebCrypto when it is an `ArrayBufferView` over a
 * plain, non-shared buffer it owns outright — offset 0, and exactly as long as
 * the buffer. Anything else means a view leaked through unconverted.
 */
function assertSafeBufferSource(value: BufferSource | undefined, label: string): void {
  assert.ok(value !== undefined, `${label} must be present`);
  // `assert.fail` returns `never`, which is what narrows `value` for the rest of the body.
  if (!ArrayBuffer.isView(value)) assert.fail(`${label} must be an ArrayBufferView, not a raw ArrayBuffer`);
  assert.equal(value.buffer instanceof SharedArrayBuffer, false, `${label} must not be SharedArrayBuffer-backed`);
  assert.ok(value.buffer instanceof ArrayBuffer, `${label} must be backed by a plain ArrayBuffer`);
  assert.equal(value.byteOffset, 0, `${label} must start at offset 0 (a leaked view would not)`);
  assert.equal(
    value.buffer.byteLength,
    value.byteLength,
    `${label} must own its whole buffer — a view over a larger allocation leaked through`,
  );
}

function aesParams(call: SubtleCall): AesGcmParams {
  assert.ok(call.algorithm instanceof Object, 'expected a normalized algorithm object');
  // SAFETY: every captured call comes from the AES-GCM envelope path, and the
  // check above confirms WebCrypto normalized the identifier into its params object.
  return call.algorithm as AesGcmParams;
}

// ---------------------------------------------------------------------------
// toBufferSource
// ---------------------------------------------------------------------------

test('toBufferSource copies a view at a nonzero offset, preserving exactly its bytes', () => {
  const view = offsetView();
  const converted = toBufferSource(view);

  assert.deepEqual([...converted], [...view], 'the copy must hold the VIEW’s bytes, not the buffer’s');
  assert.equal(converted.byteOffset, 0);
  assert.equal(converted.buffer.byteLength, view.byteLength);
});

test('toBufferSource turns a SharedArrayBuffer-backed view into a plain one', () => {
  // `.buffer.slice()` — the conversion this replaced — returns a
  // SharedArrayBuffer here, which WebCrypto rejects.
  const view = wasmMemoryView({ shared: true });
  assert.ok(view.buffer instanceof SharedArrayBuffer, 'precondition: the fixture really is shared');

  const converted = toBufferSource(view);

  assert.equal(converted.buffer instanceof SharedArrayBuffer, false);
  assert.ok(converted.buffer instanceof ArrayBuffer);
  assert.deepEqual([...converted], [...view]);
});

test('toBufferSource always allocates — mutating the source afterwards cannot change the copy', () => {
  const source = new Uint8Array([1, 2, 3, 4]);
  const converted = toBufferSource(source);
  source[0] = 99;

  assert.equal(converted[0], 1, 'the copy must be independent of the source buffer');
});

// ---------------------------------------------------------------------------
// The Chrome-only `additionalData` bug
// ---------------------------------------------------------------------------

test('the AES-GCM algorithm object OMITS additionalData when there is no AAD', async () => {
  // THE REGRESSION THIS FILE EXISTS FOR. `{ additionalData: undefined }` is
  // accepted by Node and rejected by Chrome, so this can only be caught by
  // inspecting the object — never by expecting a throw.
  const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  const { calls } = await captureSubtleCalls(async () => {
    const { iv, ciphertext } = await aesGcmEncrypt({ key, plaintext: new Uint8Array([1, 2, 3]) });
    return aesGcmDecrypt({ key, iv, ciphertext });
  });

  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.equal(
      Object.hasOwn(aesParams(call), 'additionalData'),
      false,
      `${call.operation}: the additionalData KEY must be absent, not present-and-undefined — Chrome checks existence before type`,
    );
  }
});

test('the AES-GCM algorithm object carries additionalData as a real BufferSource when there IS an AAD', async () => {
  const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  const aad = offsetView();
  const { calls } = await captureSubtleCalls(async () => {
    const { iv, ciphertext } = await aesGcmEncrypt({ key, plaintext: new Uint8Array([1, 2, 3]), additionalData: aad });
    return aesGcmDecrypt({ key, iv, ciphertext, additionalData: aad });
  });

  for (const call of calls) {
    const params = aesParams(call);
    assert.equal(Object.hasOwn(params, 'additionalData'), true, `${call.operation} lost its AAD`);
    assertSafeBufferSource(params.additionalData, `${call.operation} additionalData`);
  }
});

test('every AES-GCM argument reaching WebCrypto is a safe BufferSource, even from wasm-memory views', async () => {
  const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  const { calls } = await captureSubtleCalls(async () => {
    const { iv, ciphertext } = await aesGcmEncrypt({
      key,
      plaintext: wasmMemoryView({ shared: false }),
      additionalData: wasmMemoryView({ shared: true }),
    });
    return aesGcmDecrypt({ key, iv, ciphertext, additionalData: wasmMemoryView({ shared: true }) });
  });

  for (const call of calls) {
    const params = aesParams(call);
    assertSafeBufferSource(params.iv, `${call.operation} iv`);
    assertSafeBufferSource(params.additionalData, `${call.operation} additionalData`);
    assertSafeBufferSource(call.data, `${call.operation} data`);
  }
});

// ---------------------------------------------------------------------------
// The real Argon2id-shaped path, end to end
// ---------------------------------------------------------------------------

test('a KEK derived from a WASM-MEMORY-backed hash wraps and unwraps a DEK', async () => {
  // This is the exact production shape: hash-wasm returns a view into its own
  // linear memory, that view becomes HKDF input key material, and the derived
  // KEK wraps the DEK. `wrapDek` is the first AES-GCM call in account setup —
  // the one that died in Chrome.
  const argon2idHash = wasmMemoryView({ shared: false });
  const kek = await deriveAesKeyViaHkdf({
    inputKeyMaterial: argon2idHash,
    salt: offsetView(),
    info: HKDF_INFO.PASSPHRASE_KEK,
  });

  const dek = generateDek();
  const wrapped = await wrapDek({ dek, kek });

  assert.deepEqual(await unwrapDek({ wrappedDek: wrapped, kek }), dek);
});

test('a KEK derived from a SHARED wasm-memory hash still wraps and unwraps a DEK', async () => {
  // Without the copy this throws in Node too — `.buffer.slice()` on a shared
  // buffer yields a SharedArrayBuffer, which WebCrypto refuses. So unlike the
  // additionalData case, this one fails loudly the moment the copy is removed.
  const argon2idHash = wasmMemoryView({ shared: true });
  const kek = await deriveAesKeyViaHkdf({
    inputKeyMaterial: argon2idHash,
    salt: wasmMemoryView({ shared: true }),
    info: HKDF_INFO.PASSPHRASE_KEK,
  });

  const dek = generateDek();
  const wrapped = await wrapDek({ dek, kek });

  assert.deepEqual(await unwrapDek({ wrappedDek: wrapped, kek }), dek);
});

/*
 * TRIMMED ON COPY: the two envelope round-trip cases that stood here
 * (`buildEnvelope` / `parseEnvelope`) exercised
 * `openplate/app/lib/sync/engine/envelope/build-envelope.ts`, which is the
 * blob/snapshot layer and was NOT copied into this repo. The BufferSource
 * guarantees they asserted are still covered above, at the AES-GCM boundary
 * the envelope layer itself calls into.
 */
