/**
 * COPIED, NOT SHARED. Source: openplate/app/lib/sync/engine/envelope/types.ts @ 68e893ac71d25ad7ff42280773ea0ec94f4f700e.
 * See .adr/0008-e2ee-sync-copied-not-extracted.md. Fixes belong upstream first,
 * then here. Do not let the two drift.
 */
/**
 * Data envelope + payload shapes (M117 design spec D2). The envelope is the
 * on-wire/on-disk encrypted blob; the payload is what's INSIDE it once
 * decrypted. Two independent version numbers, per D2 — do not conflate:
 * `envelopeVersion` is this crypto/wire format; `payloadSchemaVersion` is the
 * local store's own `SCHEMA_VERSION` (`app/lib/local-store/schema.ts`), which
 * the envelope only carries through as a number bound into the AAD and never
 * interprets.
 */
import { ENVELOPE_VERSION } from '#app/lib/e2ee/protocol';

/**
 * Re-exported from `../protocol` so this module's own callers don't need to
 * know where the constant lives, while `protocol.ts` stays the single
 * in-repo source of truth for every version number on the wire (M128 spec
 * 01 — it is the file kept in lockstep with `openplate-sync`).
 */
export { ENVELOPE_VERSION };

export interface DataEnvelope {
  envelopeVersion: number;
  /**
   * A single opaque blob: the 12-byte AES-GCM IV PACKED as its first bytes,
   * followed by the ciphertext with the authentication tag appended
   * (`packIvAndCiphertext`/`splitIvAndCiphertext` in `crypto/aes-gcm.ts` —
   * the one canonical place the engine packs/unpacks it). This is what
   * actually travels over the wire (base64-encoded as
   * `protocol.ts`'s `PushBlobRequest.ciphertext`) and lands in the service's
   * single `sync_blobs.ciphertext` bytea column — there is no separate `iv`
   * field anywhere downstream of `buildEnvelope`.
   */
  ciphertext: Uint8Array;
}

/**
 * The AAD binding D2 requires — accountId + blobVersion + payloadSchemaVersion
 * — defeats cut-and-paste (a blob from a different account) and rollback (an
 * old blob version, or a payload from an incompatible schema version) attacks.
 */
export interface EnvelopeAadFields {
  accountId: number;
  blobVersion: number;
  payloadSchemaVersion: number;
}

/**
 * The plaintext payload once an envelope is decrypted: a sync-metadata layer
 * wrapped around the UNTOUCHED backup snapshot (D2). `snapshot` stays
 * `unknown` on purpose — its real shape is `LocalStoreSnapshot`
 * (`app/lib/local-store/schema.ts`), and keeping the engine ignorant of it is
 * what lets the local-store schema evolve (its own `payloadSchemaVersion`)
 * without touching a line of crypto. Only local-store code parses it.
 */
export interface SyncPayload {
  snapshot: unknown;
  syncMeta: SyncMetaPayload;
}

/** Re-exported here (not just from `../merge/types`) so `SyncPayload`'s own shape is self-contained to read. */
export interface SyncMetaPayload {
  perEntity: Record<string, { lamport: number; deviceId: string }>;
  tombstones: {
    entityId: string;
    entityType: string;
    lamport: number;
    deviceId: string;
  }[];
}
