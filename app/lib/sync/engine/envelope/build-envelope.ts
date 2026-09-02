/**
 * COPIED, NOT SHARED. Source: openplate/app/lib/sync/engine/envelope/build-envelope.ts @ 68e893ac71d25ad7ff42280773ea0ec94f4f700e.
 * See .adr/0008-e2ee-sync-copied-not-extracted.md. Fixes belong upstream first,
 * then here. Do not let the two drift.
 */
/**
 * Builds/parses the data envelope (M117 design spec D2) — the encrypted blob
 * a client pushes to (and pulls from) the sync service.
 *
 * The `ENVELOPE_VERSION` 1 pipeline, in order:
 *   build:  payload -> JSON -> UTF-8 bytes -> gzip -> AES-256-GCM(+AAD) -> pack(iv || ciphertext)
 *   parse:  split(iv, ciphertext) -> AES-256-GCM decrypt(+AAD) -> gunzip -> UTF-8 -> JSON -> payload
 *
 * `payload.snapshot` stays `unknown` (opaque) end to end — this module only
 * encrypts and decrypts bytes, it never interprets what they mean.
 *
 * Compression is applied to the PLAINTEXT, before encryption (M128 spec 01,
 * counsel 2026-08-03) — see `compression.ts` for why it is needed, why it
 * cannot be applied after encryption, and the honest statement of the
 * compression-oracle caveat that comes with the ordering.
 *
 * M117 security review finding #1: `buildEnvelope` PACKS the IV as the first
 * 12 bytes of `DataEnvelope.ciphertext` (`packIvAndCiphertext`) and
 * `parseEnvelope` splits it back off (`splitIvAndCiphertext`) — this is the
 * one canonical place the IV-packing happens for the data blob (the OTHER
 * canonical place is `crypto/dek-wrap.ts`'s `wrapDek`/`unwrapDek`, for the
 * wrapped DEK). Previously the IV was a separate, never-transmitted field —
 * doc comments claimed it "rides inside" the ciphertext with no code that
 * actually did so.
 */
import { aesGcmDecrypt, aesGcmEncrypt, packIvAndCiphertext, splitIvAndCiphertext } from '#app/lib/e2ee/crypto/aes-gcm';
import { toBufferSource } from '#app/lib/e2ee/crypto/buffer-source';
import { buildEnvelopeAad } from './aad';
import { gzipCompress, gzipDecompress } from './compression';
import { ENVELOPE_VERSION, type DataEnvelope, type EnvelopeAadFields, type SyncPayload } from './types';

/** Imports raw DEK bytes as a non-extractable AES-GCM `CryptoKey`. */
export async function importDekAsAesKey(dek: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', toBufferSource(dek), 'AES-GCM', false, ['encrypt', 'decrypt']);
}

/**
 * Encrypts `payload` under `dek`, producing the envelope the client pushes.
 * `aadFields` must be the SAME `{accountId, blobVersion, payloadSchemaVersion}`
 * the caller will later present when pulling and decrypting this exact blob
 * — a mismatch fails decryption by design (D2's rollback/cut-and-paste defense).
 */
export async function buildEnvelope({
  payload,
  dek,
  aadFields,
}: {
  payload: SyncPayload;
  dek: Uint8Array;
  aadFields: EnvelopeAadFields;
}): Promise<DataEnvelope> {
  const key = await importDekAsAesKey(dek);
  const plaintext = await gzipCompress(new TextEncoder().encode(JSON.stringify(payload)));
  const aad = buildEnvelopeAad(aadFields);
  const { iv, ciphertext } = await aesGcmEncrypt({ key, plaintext, additionalData: aad });
  return { envelopeVersion: ENVELOPE_VERSION, ciphertext: packIvAndCiphertext(iv, ciphertext) };
}

/**
 * Decrypts `envelope` back into its plaintext `SyncPayload`.
 *
 * @throws when the envelope's own version is one this build doesn't
 * understand, when decryption fails (wrong DEK, tampered ciphertext, or
 * `aadFields` not matching what was used to encrypt), or when the decrypted
 * bytes are not a valid gzip stream. Every one of those is a hard failure —
 * there is no partial recovery of a blob whose framing we can't verify.
 */
export async function parseEnvelope({
  envelope,
  dek,
  aadFields,
}: {
  envelope: DataEnvelope;
  dek: Uint8Array;
  aadFields: EnvelopeAadFields;
}): Promise<SyncPayload> {
  if (envelope.envelopeVersion !== ENVELOPE_VERSION) {
    throw new Error(
      `Unsupported envelope version ${envelope.envelopeVersion} (this build understands ${ENVELOPE_VERSION})`,
    );
  }
  const key = await importDekAsAesKey(dek);
  const aad = buildEnvelopeAad(aadFields);
  const { iv, ciphertext } = splitIvAndCiphertext(envelope.ciphertext);
  const compressed = await aesGcmDecrypt({ key, iv, ciphertext, additionalData: aad });
  const plaintextJson = new TextDecoder().decode(await gzipDecompress(compressed));
  // SAFETY: these bytes decrypted under this account's DEK with this
  // envelope's AAD, so the only writer that could have produced them is
  // `buildEnvelope` above — which serializes a `SyncPayload`. A tampered,
  // foreign, or replayed blob fails the AES-GCM tag before reaching here.
  return JSON.parse(plaintextJson) as SyncPayload;
}
