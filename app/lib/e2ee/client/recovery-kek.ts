/**
 * COPIED, NOT SHARED. Source: openplate/app/lib/sync/engine/client/recovery-kek.ts @ 68e893ac71d25ad7ff42280773ea0ec94f4f700e.
 * See .adr/0008-e2ee-sync-copied-not-extracted.md. Fixes belong upstream first,
 * then here. Do not let the two drift.
 */
/**
 * The recovery-code KEK derivation (design spec D5): `recovery code -> HKDF
 * -> AES-256-GCM KEK`. Deliberately skips Argon2id — a ≥128-bit random code
 * needs no memory-hard stretch (only low-entropy human passphrases do), so
 * its key record's KDF descriptor carries no params at all (D2).
 */
import { bytesToBase64 } from '#app/lib/e2ee/crypto/base64';
import { decodeCrockfordBase32, encodeCrockfordBase32, groupCharacters } from '#app/lib/e2ee/crypto/base32';
import { deriveAesKeyViaHkdf, deriveHkdfBits, HKDF_INFO } from '#app/lib/e2ee/crypto/hkdf';

/** Recovery-code entropy (D5: "≥128-bit entropy, grouped base32"). 20 bytes = 160 bits, comfortably over the floor. */
export const RECOVERY_CODE_BYTES = 20;

/**
 * Recovery codes are shown in groups of 5. The alphabet itself moved to
 * `crypto/base32.ts` when the share-key fingerprint (ADR-0002) became a second
 * consumer of it — same table, different grouping. Two copies of that table
 * would be a silent way for two different keys to render the same string.
 */
const GROUP_SIZE = 5;

/** A freshly generated recovery code: the raw entropy the KEK is derived from, plus the grouped form shown to the user. */
export interface RecoveryCode {
  raw: Uint8Array;
  formatted: string;
}

/** Generates a fresh random recovery code, formatted as groups of 5 for readability (D5: "shown once at sync setup"). */
export function generateRecoveryCode(): RecoveryCode {
  const raw = crypto.getRandomValues(new Uint8Array(RECOVERY_CODE_BYTES));
  return { raw, formatted: formatRecoveryCode(raw) };
}

/** Encodes raw bytes as a grouped base32 string (`XXXXX-XXXXX-...`) for display/entry. Pure — used by both generation and re-entry validation. */
export function formatRecoveryCode(raw: Uint8Array): string {
  return groupCharacters(encodeCrockfordBase32(raw), GROUP_SIZE);
}

/** Parses a user-entered (possibly re-typed, re-grouped) recovery code back into raw bytes. Returns `null` for an invalid/malformed code. */
export function parseRecoveryCode(formatted: string): Uint8Array | null {
  return decodeCrockfordBase32(formatted);
}

/** Derives the recovery KEK directly from the raw recovery-code bytes — no Argon2id, no salt (D5). */
export async function deriveRecoveryKek(rawRecoveryCode: Uint8Array): Promise<CryptoKey> {
  // HKDF requires a salt argument; an empty salt is the documented,
  // acceptable choice for HKDF when the input key material is already
  // high-entropy (RFC 5869 §3.1) — true here by construction (a ≥128-bit
  // random code), unlike a human passphrase which always needs a real salt.
  return deriveAesKeyViaHkdf({
    inputKeyMaterial: rawRecoveryCode,
    salt: new Uint8Array(0),
    info: HKDF_INFO.RECOVERY_KEK,
  });
}

/**
 * Derives the compartment's RECOVERY door (`K_pr`) from the same raw recovery
 * code — `openplate-sync` ADR-0002's partition amendment.
 *
 * A SIBLING of {@link deriveRecoveryKek}, never the same key: that one opens
 * the DEK, whose domain a clinician share discloses, and this one opens the
 * compartment that must survive such a share. Empty salt for the identical
 * RFC 5869 §3.1 reason — the input is already a ≥128-bit random code.
 */
export async function derivePrivateStoreRecoveryKek(rawRecoveryCode: Uint8Array): Promise<CryptoKey> {
  return deriveAesKeyViaHkdf({
    inputKeyMaterial: rawRecoveryCode,
    salt: new Uint8Array(0),
    info: HKDF_INFO.PRIVATE_STORE_RECOVERY_KEK,
  });
}

/**
 * `recoveryAuthHash` length in bytes — the same 32 the passphrase `authHash`
 * uses (`PROTOCOL.md` §3.1), because the service checks one width for both.
 */
export const RECOVERY_AUTH_HASH_BYTES = 32;

/**
 * Derives the value sent to `POST /v1/auth/recover` to prove possession of
 * the recovery code, base64 as it goes on the wire.
 *
 * A SIBLING of {@link deriveRecoveryKek}, NEVER the same output, and this is
 * the one thing about this module that must not be simplified. That function
 * derives the key that WRAPS the DEK; this one derives a value that LEAVES
 * the device. Feeding the KEK to the server instead would hand the operator
 * material derived from the same HKDF output as the key that opens the
 * diary — and it would work, silently, because an auth proof is only ever
 * compared, never used to decrypt anything. The distinct `info` label is the
 * whole separation.
 *
 * Empty salt for the identical RFC 5869 §3.1 reason the KEK uses one: the
 * input is already a >=128-bit random code, so there is no low-entropy
 * pre-image a salt would protect.
 */
export async function deriveRecoveryAuthHash(rawRecoveryCode: Uint8Array): Promise<string> {
  const bits = await deriveHkdfBits({
    inputKeyMaterial: rawRecoveryCode,
    salt: new Uint8Array(0),
    info: HKDF_INFO.RECOVERY_AUTH,
    lengthBytes: RECOVERY_AUTH_HASH_BYTES,
  });
  return bytesToBase64(bits);
}
