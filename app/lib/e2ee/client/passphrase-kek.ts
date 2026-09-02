/**
 * COPIED, NOT SHARED. Source: openplate/app/lib/sync/engine/client/passphrase-kek.ts @ 68e893ac71d25ad7ff42280773ea0ec94f4f700e.
 * See .adr/0008-e2ee-sync-copied-not-extracted.md. Fixes belong upstream first,
 * then here. Do not let the two drift.
 */
/**
 * The passphrase KEK derivation chain (design spec D1):
 * `passphrase -> Argon2id (memory-hard) -> HKDF-SHA-256 -> AES-256-GCM KEK`.
 *
 * This module composes `crypto/argon2.ts` + `crypto/hkdf.ts` but does NOT
 * decide where Argon2id runs — the host app is responsible for calling the
 * Argon2id step inside `crypto/argon2.worker.ts` (D1 requires the Worker;
 * see that file's doc comment) and passing the resulting hash in here, so
 * this composition itself stays synchronous-shaped and directly testable
 * with `node:test` (no Worker runtime needed in tests).
 */
import { deriveAesKeyViaHkdf, HKDF_INFO } from '#app/lib/e2ee/crypto/hkdf';
import { base64ToBytes, bytesToBase64 } from '#app/lib/e2ee/crypto/base64';
import { ARGON2ID_DEFAULT_PARAMS, type Argon2idParams } from '#app/lib/e2ee/crypto/argon2';

/**
 * Declared as a type alias rather than an interface deliberately: the
 * descriptor travels on the wire as `KeyRecordWire['kdfDescriptor']`
 * (`Record<string, unknown> | null`), and only a type alias gets TypeScript's
 * implicit index signature that makes it assignable there.
 */
export type PassphraseKdfDescriptor = {
  /** base64-encoded Argon2id salt — not secret, stored server-side in the key record (D4). */
  salt: string;
  params: Argon2idParams;
};

/** Builds a fresh KDF descriptor for a NEW passphrase setup (D1's parameter starting point). */
export function createPassphraseKdfDescriptor(
  salt: Uint8Array,
  params: Argon2idParams = ARGON2ID_DEFAULT_PARAMS,
): PassphraseKdfDescriptor {
  return { salt: bytesToBase64(salt), params };
}

/**
 * Derives the passphrase KEK from an ALREADY-COMPUTED Argon2id hash (the
 * host app runs Argon2id itself, in a Worker — see the module doc comment
 * above) plus the same salt recorded in the KDF descriptor.
 */
export async function derivePassphraseKek({
  argon2idHash,
  descriptor,
}: {
  argon2idHash: Uint8Array;
  descriptor: PassphraseKdfDescriptor;
}): Promise<CryptoKey> {
  return deriveAesKeyViaHkdf({
    inputKeyMaterial: argon2idHash,
    salt: base64ToBytes(descriptor.salt),
    info: HKDF_INFO.PASSPHRASE_KEK,
  });
}
