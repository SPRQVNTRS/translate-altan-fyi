/**
 * COPIED, NOT SHARED. Source: openplate/app/lib/sync/engine/crypto/aes-gcm.ts @ 68e893ac71d25ad7ff42280773ea0ec94f4f700e.
 * See .adr/0008-e2ee-sync-copied-not-extracted.md. Fixes belong upstream first,
 * then here. Do not let the two drift.
 */
/**
 * AES-256-GCM encrypt/decrypt (design spec D1/D2) — native WebCrypto, no
 * WASM. Used both to wrap the DEK with a KEK (D1) and to encrypt the data
 * envelope with the DEK (D2). AAD binding (accountId + blobVersion +
 * payloadSchemaVersion, per D2) is the CALLER's responsibility — this module
 * only knows about bytes, not what they mean.
 *
 * ── THE BROWSER-ONLY BUG THIS MODULE NOW GUARDS AGAINST ──────────────────
 *
 * `additionalData` must be ABSENT from the algorithm object when there is no
 * AAD — NOT present with the value `undefined`. Chrome checks whether the
 * property EXISTS before checking its type, so `{ additionalData: undefined }`
 * is read as "an AAD was supplied" and then rejected:
 *
 *     Failed to execute 'encrypt' on 'SubtleCrypto':
 *     AeadParams: additionalData: Not a BufferSource
 *
 * Node's WebCrypto follows the WebIDL rule that an `undefined` dictionary
 * member is equivalent to an absent one, so it accepts the same object
 * happily. This engine's whole test suite runs on Node — which is how a
 * one-line ternary (`additionalData ? … : undefined`) shipped a `wrapDek` that
 * could not execute a single time in a real browser, failing sync account
 * creation before any request left the page, with every gate green.
 *
 * Hence {@link buildAesGcmParams}: the ONE place the algorithm object is
 * constructed, so the key can never be reintroduced unconditionally.
 * `tests/unit/sync-engine/webcrypto-inputs.test.ts` asserts on the object
 * itself, because Node cannot reproduce the rejection.
 */
import { toBufferSource } from './buffer-source';

/** GCM's standard 96-bit (12-byte) nonce/IV — the size WebCrypto's `AES-GCM` expects for best performance/safety. */
export const AES_GCM_IV_BYTES = 12;

export interface AesGcmEncryptResult {
  /** A fresh random IV generated for this encryption — must travel alongside the ciphertext (it is not secret). */
  iv: Uint8Array;
  /** Ciphertext with the GCM authentication tag appended (WebCrypto's own convention). */
  ciphertext: Uint8Array;
}

/** Generates a fresh random 96-bit IV. Exported so callers/tests can inject a deterministic one where needed. */
export function generateIv(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(AES_GCM_IV_BYTES));
}

/**
 * Encrypts `plaintext` under `key` with a fresh random IV, optionally binding
 * `additionalData` (AAD) — authenticated but not encrypted; a tampered AAD
 * fails decryption (D2's cut-and-paste/rollback defense).
 */
export async function aesGcmEncrypt({
  key,
  plaintext,
  additionalData,
}: {
  key: CryptoKey;
  plaintext: Uint8Array;
  additionalData?: Uint8Array;
}): Promise<AesGcmEncryptResult> {
  const iv = generateIv();
  const ciphertext = await crypto.subtle.encrypt(
    buildAesGcmParams({ iv, additionalData }),
    key,
    toBufferSource(plaintext),
  );
  return { iv, ciphertext: new Uint8Array(ciphertext) };
}

/**
 * Builds the `AesGcmParams` dictionary.
 *
 * The conditional assignment is load-bearing, not style: see this module's
 * header for why an `additionalData` key that exists with the value
 * `undefined` makes Chrome reject the call outright while Node accepts it.
 * Every byte array is copied through {@link toBufferSource} on the way in.
 * The IV and the AAD get the same treatment as the plaintext deliberately:
 * there is no reason for one of the three to be trusted more than the others.
 */
function buildAesGcmParams({ iv, additionalData }: { iv: Uint8Array; additionalData?: Uint8Array }): AesGcmParams {
  const params: AesGcmParams = { name: 'AES-GCM', iv: toBufferSource(iv) };
  if (additionalData !== undefined) params.additionalData = toBufferSource(additionalData);
  return params;
}

/**
 * Decrypts `ciphertext` (as produced by {@link aesGcmEncrypt}) under `key`.
 * Throws (WebCrypto's own `OperationError`) when the tag doesn't verify —
 * wrong key, tampered ciphertext, or a mismatched `additionalData`.
 */
export async function aesGcmDecrypt({
  key,
  iv,
  ciphertext,
  additionalData,
}: {
  key: CryptoKey;
  iv: Uint8Array;
  ciphertext: Uint8Array;
  additionalData?: Uint8Array;
}): Promise<Uint8Array> {
  const plaintext = await crypto.subtle.decrypt(
    buildAesGcmParams({ iv, additionalData }),
    key,
    toBufferSource(ciphertext),
  );
  return new Uint8Array(plaintext);
}

/**
 * Packs an IV and its ciphertext into ONE opaque blob for a wire/DB field
 * that only has room for a single ciphertext slot (`iv || ciphertext`) —
 * the canonical packed format `envelope/build-envelope.ts` and
 * `crypto/dek-wrap.ts` both use (security review finding #1: doc comments
 * throughout the engine and its host previously CLAIMED the IV "rides
 * inside" the ciphertext without any code actually packing it — this
 * function, and {@link splitIvAndCiphertext}, are that one canonical place).
 */
export function packIvAndCiphertext(iv: Uint8Array, ciphertext: Uint8Array): Uint8Array {
  const packed = new Uint8Array(iv.byteLength + ciphertext.byteLength);
  packed.set(iv, 0);
  packed.set(ciphertext, iv.byteLength);
  return packed;
}

/** The two parts a packed `iv || ciphertext` blob splits back into. */
export interface IvAndCiphertext {
  /** The leading `AES_GCM_IV_BYTES` of the packed blob. */
  iv: Uint8Array;
  /** Everything after the IV: ciphertext with its GCM tag appended. */
  ciphertext: Uint8Array;
}

/**
 * Splits a blob produced by {@link packIvAndCiphertext} back into its IV
 * (the first `AES_GCM_IV_BYTES`) and ciphertext.
 *
 * @throws if `packed` is too short to contain a full IV.
 */
export function splitIvAndCiphertext(packed: Uint8Array): IvAndCiphertext {
  if (packed.byteLength < AES_GCM_IV_BYTES) {
    throw new Error(`packed ciphertext too short to contain a ${AES_GCM_IV_BYTES}-byte IV`);
  }
  return { iv: packed.slice(0, AES_GCM_IV_BYTES), ciphertext: packed.slice(AES_GCM_IV_BYTES) };
}
