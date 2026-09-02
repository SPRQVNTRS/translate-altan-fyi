/**
 * COPIED, NOT SHARED. Source: openplate/app/lib/sync/engine/crypto/buffer-source.ts @ 68e893ac71d25ad7ff42280773ea0ec94f4f700e.
 * See .adr/0008-e2ee-sync-copied-not-extracted.md. Fixes belong upstream first,
 * then here. Do not let the two drift.
 */
/**
 * The ONE conversion every WebCrypto (and `CompressionStream`) boundary in
 * this engine goes through.
 *
 * ── Why a helper rather than an inline slice ─────────────────────────────
 *
 * Three modules had each grown their own private `toArrayBuffer` copy
 * (`aes-gcm.ts`, `hkdf.ts`, `build-envelope.ts`), all spelled
 * `bytes.buffer.slice(byteOffset, byteOffset + byteLength)`. They agreed, but
 * a wrong conversion here does not throw a nice error — it either hands the
 * platform a rejected argument or, worse, the WRONG BYTES (a view's `buffer`
 * is the whole underlying allocation, so forgetting the offset silently
 * encrypts a neighbouring region). One implementation, one place to be right.
 *
 * ── What can arrive here ─────────────────────────────────────────────────
 *
 * Measured, not assumed — `hash-wasm@4.11.0`'s Argon2id output was checked
 * directly and is a CLEAN standalone `Uint8Array` (offset 0, owning its own
 * 32-byte plain buffer), so today nothing in this engine actually hands
 * WebCrypto an exotic view. This helper is therefore INSURANCE, not the fix
 * for any live bug — the live bug was `additionalData: undefined`
 * (`aes-gcm.ts`). It is worth the 32 bytes because the sources feeding it are
 * ones whose shape is not ours to guarantee:
 *
 *  1. `crypto.getRandomValues(new Uint8Array(n))` — plain, offset 0.
 *  2. **hash-wasm's Argon2id output.** Clean at the exact pinned version, but
 *     that is an implementation detail of a dependency, not a contract. A WASM
 *     hashing library returning a view into its own linear memory is the
 *     normal design; if a future bump does that, and that memory is growable
 *     or shared, its `ArrayBuffer` is not something Chrome accepts as a
 *     `BufferSource` at all.
 *  3. **Values that crossed the Worker boundary** via `postMessage`, whose
 *     backing buffer belongs to the structured-clone result.
 *  4. Slices of a pulled blob (`splitIvAndCiphertext`), which are already
 *     copies — but only because `.slice()` happens to copy, which is not a
 *     property any caller should have to remember.
 *
 * ── Why `new Uint8Array(n)` + `.set()` and not `.buffer.slice()` ─────────
 *
 * `ArrayBuffer.prototype.slice` PRESERVES the kind of buffer it is called on:
 * slicing a `SharedArrayBuffer` yields a `SharedArrayBuffer`, which WebCrypto
 * rejects outright. Allocating a fresh `Uint8Array` and copying into it always
 * produces a plain, non-shared, non-resizable `ArrayBuffer` of exactly the
 * right length, whatever the source was. It is also the shorter code.
 *
 * A `Uint8Array` is returned rather than an `ArrayBuffer` because it satisfies
 * `BufferSource` directly AND is what Node's `CompressionStream` requires on
 * its writable side (it rejects a bare `ArrayBuffer` with
 * `ERR_INVALID_ARG_TYPE`) — so one return type works at every boundary.
 */

/**
 * Copies `bytes` into a freshly allocated, plain-`ArrayBuffer`-backed view.
 *
 * Always copies. The copy is the point: the cost is a few dozen bytes on the
 * hot paths here, and the alternative is a class of failure that only appears
 * in a real browser, only on the paths that touch WASM output, and only in
 * production.
 */
export function toBufferSource(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy;
}
