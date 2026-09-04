/**
 * The envelope and the payload inside it.
 *
 * TWO INDEPENDENT SHAPES, and it is worth keeping them apart. The ENVELOPE is
 * what the wire and the `sync_blobs.payload` column carry; the PAYLOAD is the
 * local store's own snapshot plus the sync metadata that decides merges. The
 * envelope only carries the payload's schema version through as a number and
 * never interprets it.
 *
 * THERE IS NO CRYPTO HERE ANY MORE (M191). The envelope used to be
 * `{ envelopeVersion, ciphertext }` with the schema version bound into the
 * AES-GCM additional data, because the server could not be shown the document.
 * It can now, so the schema version travels as an ordinary field and the
 * "probe every version until the tag verifies" loop the orchestrator needed is
 * gone with it.
 */
import type { JsonValue } from '#app/lib/json';

/** The framed document, exactly as it is stored and sent. */
export interface DataEnvelope {
  /** The local store's `SCHEMA_VERSION` at the time of writing. Read, never guessed. */
  payloadSchemaVersion: number;
  /** The version this document will be stored as. Diagnostic: the CAS is decided by the request's `baseVersion`. */
  blobVersion: number;
  payload: SyncPayload;
}

/**
 * The plaintext payload: a sync-metadata layer wrapped around the UNTOUCHED
 * store snapshot. `snapshot` stays unnamed here on purpose: its real shape is
 * `LocalStoreSnapshot` (`app/lib/local-store/schema.ts`), and keeping the
 * engine ignorant of it is what lets the local-store schema evolve without
 * touching a line of this module. Only local-store code parses it.
 */
export interface SyncPayload {
  snapshot: JsonValue;
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
