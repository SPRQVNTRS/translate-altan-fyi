/**
 * COPIED, NOT SHARED. Source: openplate-sync/src/contract-types.ts @ 311a1578af3ca169e8a08c6d50d90889e29d5889.
 * See .adr/0008-e2ee-sync-copied-not-extracted.md. Fixes belong upstream first,
 * then here. Do not let the two drift.
 */
/**
 * The HOST-INJECTION contract: what a host shell must provide for the blob
 * and key-record handlers — a storage adapter. Nothing here crosses the wire;
 * that is `protocol.ts`'s job.
 *
 * TRIMMED ON COPY. Upstream this file also declared the share graph, the
 * atomic DEK rotation and the research contributions. None of those features
 * exists in this repo yet, so their types are deleted rather than stubbed: a
 * type nobody implements is a promise nobody keeps. Restoring one means
 * copying it back from the source named above, not re-inventing it. The BLOB
 * half was trimmed with them and has since been restored, by that same rule.
 */
import type { SyncKeyRecordKind } from './protocol';
import type { JsonObject } from './json';

export interface SyncKeyRecord {
  accountId: number;
  kind: SyncKeyRecordKind;
  kdfDescriptor: JsonObject | null;
  /** The DEK, wrapped by this record's KEK — a SINGLE packed blob (12-byte IV + ciphertext+tag, `crypto/dek-wrap.ts`'s `wrapDek`). The server never unwraps it. */
  wrappedDek: Uint8Array;
  updatedAt: Date;
}

export interface SyncBlobRecord {
  accountId: number;
  blobVersion: number;
  envelopeVersion: number;
  /** Opaque, SINGLE packed blob (12-byte IV + AAD-bound ciphertext+tag, `envelope/build-envelope.ts`'s `buildEnvelope`) — the server never parses it. */
  ciphertext: Uint8Array;
  createdAt: Date;
}

export type PutBlobResult = { ok: true; newVersion: number } | { ok: false; currentVersion: number };

/**
 * Result of a CAS key-record write (security review finding #2 — mirrors
 * `PutBlobResult`'s optimistic-concurrency shape, applied to key records so
 * a rotation/first-time-setup race can never silently overwrite another
 * write). `currentUpdatedAt` is `null` only when the caller asserted
 * `expectedUpdatedAt: null` (first-time create) and lost the race to a
 * write that ALSO happened to fail for some other reason before any record
 * existed — in the normal case a conflict means a record now exists.
 */
export type PutKeyRecordResult = { ok: true; record: SyncKeyRecord } | { ok: false; currentUpdatedAt: Date | null };

export interface SyncStorageAdapter {
  getBlob(accountId: number): Promise<SyncBlobRecord | null>;
  putBlobIfVersionMatches(input: {
    accountId: number;
    baseVersion: number;
    envelopeVersion: number;
    ciphertext: Uint8Array;
  }): Promise<PutBlobResult>;
  listKeyRecords(accountId: number): Promise<SyncKeyRecord[]>;
  /**
   * CAS write (security review finding #2): succeeds only when
   * `expectedUpdatedAt` matches the account's current `(kind)` record —
   * `null` asserts "no record should exist yet" (first-time setup); any
   * other value asserts "the record I last read had exactly this
   * `updatedAt`" (rotation). A mismatch is a conflict, never a blind
   * upsert.
   */
  putKeyRecord(
    input: Omit<SyncKeyRecord, 'updatedAt'> & { expectedUpdatedAt: Date | null },
  ): Promise<PutKeyRecordResult>;
  deleteKeyRecord(input: { accountId: number; kind: SyncKeyRecordKind }): Promise<void>;
}
