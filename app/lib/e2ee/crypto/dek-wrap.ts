/**
 * COPIED, NOT SHARED. Source: openplate/app/lib/sync/engine/crypto/dek-wrap.ts @ 68e893ac71d25ad7ff42280773ea0ec94f4f700e.
 * See .adr/0008-e2ee-sync-copied-not-extracted.md. Fixes belong upstream first,
 * then here. Do not let the two drift.
 */
/**
 * Wraps/unwraps the account's data-encryption-key (DEK) with a
 * key-encryption-key (KEK) — the indirection D1 requires so a passphrase
 * change (or adding the recovery path) re-wraps this small value only, never
 * re-encrypting the data blob.
 *
 * Security review finding #1: a wrapped DEK is a SINGLE opaque blob — the
 * 12-byte AES-GCM IV PACKED as its first bytes, then the ciphertext+tag
 * (`packIvAndCiphertext`/`splitIvAndCiphertext`, `crypto/aes-gcm.ts` — this
 * is the other of the two canonical packing sites, alongside
 * `envelope/build-envelope.ts`). This is exactly the shape
 * the sync service's `sync_key_records.wrapped_dek` bytea column
 * stores — there is no separate `iv` field anywhere downstream of `wrapDek`.
 */
import { aesGcmDecrypt, aesGcmEncrypt, packIvAndCiphertext, splitIvAndCiphertext } from './aes-gcm';

/** DEK length in bytes — AES-256. */
export const DEK_BYTES = 32;

export function generateDek(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(DEK_BYTES));
}

/**
 * Wraps `dek` with `kek`, returning the packed `iv || ciphertext` blob.
 *
 * `additionalData` is OPTIONAL and the two callers differ on purpose
 * (`PROTOCOL.md` §3.2 vs §3.4):
 *
 *  - **Key-record wraps pass none.** A wrapped DEK isn't bound to a specific
 *    blob version (D2: only the data envelope's ciphertext is), and the row
 *    holding it is owner-only — an owner's KEK and an owner's DEK cannot be
 *    confused with anyone else's, so there is nothing to bind to.
 *  - **A share wrap passes AAD** (`crypto/share-wrap.ts`), because it sits in
 *    a server-controlled association table where a malicious server could
 *    splice one patient's wrap into a row pointing at another patient's blob.
 *    The binding turns that splice into a tag failure instead of a
 *    misattributed diary.
 *
 * This parameter exists so the share path REUSES this one wrap implementation
 * rather than growing a second one beside it. A second implementation is how
 * the packed-IV convention (finding #1) drifts.
 */
export async function wrapDek({
  dek,
  kek,
  additionalData,
}: {
  dek: Uint8Array;
  kek: CryptoKey;
  additionalData?: Uint8Array;
}): Promise<Uint8Array> {
  const { iv, ciphertext } = await aesGcmEncrypt({ key: kek, plaintext: dek, additionalData });
  return packIvAndCiphertext(iv, ciphertext);
}

/**
 * Unwraps a DEK previously wrapped by {@link wrapDek}.
 *
 * Throws if `kek` doesn't match (wrong passphrase/recovery code), if
 * `additionalData` differs by so much as one byte from what the wrap was
 * built with, or if `wrappedDek` is malformed. All three are the same
 * `OperationError` from WebCrypto — a GCM tag check does not say WHY it
 * failed, and callers must not pretend to know.
 */
export async function unwrapDek({
  wrappedDek,
  kek,
  additionalData,
}: {
  wrappedDek: Uint8Array;
  kek: CryptoKey;
  additionalData?: Uint8Array;
}): Promise<Uint8Array> {
  const { iv, ciphertext } = splitIvAndCiphertext(wrappedDek);
  return aesGcmDecrypt({ key: kek, iv, ciphertext, additionalData });
}
