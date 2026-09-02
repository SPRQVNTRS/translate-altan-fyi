/**
 * COPIED, NOT SHARED. Source: openplate/app/lib/sync/engine/crypto/base32.ts @ 68e893ac71d25ad7ff42280773ea0ec94f4f700e.
 * See .adr/0008-e2ee-sync-copied-not-extracted.md. Fixes belong upstream first,
 * then here. Do not let the two drift.
 */
/**
 * Crockford-style base32 — the one implementation.
 *
 * Two surfaces render binary as human-transcribable text in this product, and
 * they must use the SAME alphabet or a person reading one and typing the other
 * would hit characters the decoder rejects:
 *
 *  1. The recovery code (`client/recovery-kek.ts`, `PROTOCOL.md` §3.1) — 20
 *     random bytes in groups of 5.
 *  2. The share-key fingerprint (`crypto/share-wrap.ts`, ADR-0002's typed
 *     ceremony) — a SHA-256 digest, displayed in groups of 4.
 *
 * The alphabet omits `O`, `I` and `L` precisely because those are the
 * characters a human mis-transcribes, and the fingerprint ceremony is a person
 * reading a string aloud to another person who types it. A second copy of this
 * table that drifted by one character would make every fingerprint comparison
 * fail — or, far worse, make two different keys render the same string.
 *
 * Pure: no randomness, no I/O, no WebCrypto.
 */

/** Crockford-style base32, no padding. Excludes the easily-confused `O`, `I` and `L`. FROZEN — a recovery code encoded under a different table cannot be re-entered. */
export const CROCKFORD_BASE32_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** Encodes bytes as an ungrouped Crockford-style base32 string. The final character carries the leftover bits, zero-padded. */
export function encodeCrockfordBase32(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let output = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += CROCKFORD_BASE32_ALPHABET[(value >>> (bits - 5)) & 0x1f];
      bits -= 5;
    }
  }
  if (bits > 0) {
    output += CROCKFORD_BASE32_ALPHABET[(value << (5 - bits)) & 0x1f];
  }
  return output;
}

/**
 * Decodes a possibly re-grouped, possibly lower-case string back into bytes.
 *
 * Returns `null` for an empty or malformed input rather than throwing: both
 * callers are validating something a human just typed, where "that is not a
 * valid code" is an expected outcome and not an exceptional one.
 *
 * Separators (`-`, spaces, anything outside `0-9A-Z`) are stripped, so a code
 * re-typed with different grouping still decodes.
 */
export function decodeCrockfordBase32(text: string): Uint8Array | null {
  const cleaned = text.toUpperCase().replace(/[^0-9A-Z]/g, '');
  if (cleaned.length === 0) return null;

  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const char of cleaned) {
    const charValue = CROCKFORD_BASE32_ALPHABET.indexOf(char);
    if (charValue === -1) return null;
    value = (value << 5) | charValue;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return new Uint8Array(bytes);
}

/** Splits `text` into `-`-joined groups of `size` characters, for display and hand transcription. */
export function groupCharacters(text: string, size: number): string {
  return (text.match(new RegExp(`.{1,${size}}`, 'g')) ?? [text]).join('-');
}
