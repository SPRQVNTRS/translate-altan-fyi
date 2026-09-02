/**
 * COPIED, NOT SHARED. Source: openplate/app/lib/sync/engine/crypto/base64.ts @ 68e893ac71d25ad7ff42280773ea0ec94f4f700e.
 * See .adr/0008-e2ee-sync-copied-not-extracted.md. Fixes belong upstream first,
 * then here. Do not let the two drift.
 */
/**
 * Base64 <-> bytes, the one implementation.
 *
 * `PROTOCOL.md` §4 puts every binary field (`ciphertext`, `wrappedDek`,
 * `authHash`) on the wire as standard-alphabet base64 with padding, which
 * meant three modules in this engine had each grown their own private copy of
 * the same eight-line loop. They agreed, which is exactly why the duplication
 * was worth removing before a fourth copy disagreed: a base64 bug here does
 * not throw, it produces bytes that fail a GCM tag check somewhere else
 * entirely.
 *
 * `atob`/`btoa` are used rather than `Buffer` deliberately — this code runs in
 * the browser, and both are global in Node 16+ too, so the unit tests exercise
 * the same path production does.
 */

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}
