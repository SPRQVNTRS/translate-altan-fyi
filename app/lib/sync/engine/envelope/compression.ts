/**
 * COPIED, NOT SHARED. Source: openplate/app/lib/sync/engine/envelope/compression.ts @ 68e893ac71d25ad7ff42280773ea0ec94f4f700e.
 * See .adr/0008-e2ee-sync-copied-not-extracted.md. Fixes belong upstream first,
 * then here. Do not let the two drift.
 */
/**
 * gzip compression for the envelope's plaintext, applied BEFORE encryption
 * (M128 spec 01, counsel 2026-08-03).
 *
 * WHY COMPRESS AT ALL: the sync blob is the whole local store serialized as
 * JSON, and food-log entries run ~400–700 bytes each before compression. Left
 * uncompressed, a daily user reaches the 2MB blob cap
 * (`protocol.ts`'s `MAX_BLOB_BYTES`) within 2–4 years. Highly repetitive JSON
 * — the same key names on every one of thousands of records — is close to the
 * best case for gzip, so this buys roughly an order of magnitude of headroom
 * for one dependency-free step. The chunked/per-entity blob redesign that
 * eventually replaces it is a future protocol-version bump, recorded in
 * `openplate-sync/PROTOCOL.md`.
 *
 * WHY COMPRESS BEFORE ENCRYPTING (and not after): ciphertext is
 * indistinguishable from random data and does not compress. Compression has
 * to happen on the plaintext or not at all.
 *
 * THE COMPRESSION-ORACLE CAVEAT, STATED HONESTLY: compress-then-encrypt is
 * the pattern behind CRIME/BREACH, where an attacker who can (a) inject
 * chosen plaintext into the same compression context as a secret and
 * (b) observe the resulting ciphertext length, can recover the secret byte by
 * byte. Neither precondition holds here: one blob is one whole-store snapshot
 * produced by the user's own device on its own schedule, an attacker has no
 * channel for injecting attacker-chosen bytes into it, and the service
 * already sees the exact blob length regardless of compression. What DOES
 * leak — and leaked before this change too — is an approximation of how much
 * data an account holds. That is accepted and documented in PROTOCOL.md.
 *
 * WHY `CompressionStream` AND NOT `node:zlib` OR A LIBRARY: this module runs
 * in the BROWSER (and in `node --test` for its unit tests).
 * `CompressionStream`/`DecompressionStream` are web-standard and present in
 * both — every current browser and Node ≥18 — so the engine stays free of any
 * runtime dependency and free of a `node:*` import that would break the
 * client bundle.
 *
 * NO BACK-COMPAT PATH: compression is folded into `ENVELOPE_VERSION` 1 rather
 * than shipped as version 2, because zero production blobs exist. There is
 * deliberately no "try gunzip, fall back to raw" branch — a fallback here
 * would be untested guesswork forever.
 */

import { toBufferSource } from '#app/lib/e2ee/crypto/buffer-source';

/** gzip-compresses `bytes`. */
export async function gzipCompress(bytes: Uint8Array): Promise<Uint8Array> {
  return runThroughTransform({ bytes, transform: new CompressionStream('gzip') });
}

/**
 * Reverses {@link gzipCompress}.
 *
 * @throws when `bytes` is not a valid gzip stream — which, inside
 * `parseEnvelope`, can only mean the plaintext was framed by a different
 * envelope version than it claimed.
 */
export async function gzipDecompress(bytes: Uint8Array): Promise<Uint8Array> {
  return runThroughTransform({ bytes, transform: new DecompressionStream('gzip') });
}

/**
 * Pushes `bytes` through a single-shot `TransformStream` and collects the
 * result.
 *
 * The write is deliberately NOT awaited before reading: a transform stream
 * applies backpressure once its internal queue fills, so awaiting a large
 * write before anyone drains the readable side would deadlock. `Response` is
 * used to drain the readable side because it consumes the whole stream
 * without a hand-rolled unbounded read loop.
 */
async function runThroughTransform({
  bytes,
  transform,
}: {
  bytes: Uint8Array;
  /** `BufferSource` on the writable side is how the DOM lib types `CompressionStream`/`DecompressionStream`. */
  transform: TransformStream<BufferSource, Uint8Array>;
}): Promise<Uint8Array> {
  const writer = transform.writable.getWriter();
  // `toBufferSource` rather than a cast. The cast this replaces was TypeScript
  // friction with a real hazard behind it: a default `Uint8Array` is
  // `Uint8Array<ArrayBufferLike>`, unassignable to `ArrayBufferView<ArrayBuffer>`
  // precisely BECAUSE it might be `SharedArrayBuffer`-backed — which is the
  // shape platforms actually reject. Copying satisfies the compiler for the
  // right reason instead of silencing it. Passing a real `ArrayBuffer` would
  // also typecheck and then throw at runtime: Node's implementation accepts
  // only a TypedArray, Buffer, or DataView (`ERR_INVALID_ARG_TYPE`).
  const written = writer.write(toBufferSource(bytes)).then(() => writer.close());
  // An erroring transform (malformed gzip input, most likely) rejects BOTH
  // sides. Mark the write side handled up front so its rejection can never
  // escape as an `unhandledRejection` — the read side below is the single
  // place a failure is thrown from, and it reports the same underlying error.
  written.catch(() => undefined);
  const collected = new Uint8Array(await new Response(transform.readable).arrayBuffer());
  await written;
  return collected;
}
