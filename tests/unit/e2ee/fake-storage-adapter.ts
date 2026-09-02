/**
 * In-memory fake `SyncStorageAdapter` for the blob and key-record handler
 * tests. It implements the same CAS semantics a real backend must (see
 * PROTOCOL.md §10), so the handler tests exercise realistic behaviour —
 * including the conflict paths — without a database.
 *
 * TRIMMED ON COPY, with `contract-types.ts`: the share graph, the atomic DEK
 * rotation and the research contributions are absent because this repo has
 * none of those tables. The blob half was trimmed with them and has since
 * been restored, alongside `sync_blobs`.
 */
import type {
  PutBlobResult,
  PutKeyRecordResult,
  SyncBlobRecord,
  SyncKeyRecord,
  SyncStorageAdapter,
} from '#app/lib/e2ee/contract-types';
import type { SyncKeyRecordKind } from '#app/lib/e2ee/protocol';

export function createFakeStorageAdapter(): SyncStorageAdapter {
  const keyRecordsByAccount = new Map<number, Map<SyncKeyRecordKind, SyncKeyRecord>>();
  /** Only the CURRENT blob per account. Retention is a storage concern, and no handler can observe it. */
  const blobsByAccount = new Map<number, SyncBlobRecord>();

  return {
    async getBlob(accountId: number): Promise<SyncBlobRecord | null> {
      return blobsByAccount.get(accountId) ?? null;
    },

    async putBlobIfVersionMatches(input): Promise<PutBlobResult> {
      // The same swap the unique index performs in Postgres: a push is
      // accepted only against the version actually stored, and a mismatch
      // reports the REAL current version rather than the one the caller
      // guessed.
      const currentVersion = blobsByAccount.get(input.accountId)?.blobVersion ?? 0;
      if (currentVersion !== input.baseVersion) {
        return { ok: false, currentVersion };
      }

      const newVersion = currentVersion + 1;
      blobsByAccount.set(input.accountId, {
        accountId: input.accountId,
        blobVersion: newVersion,
        envelopeVersion: input.envelopeVersion,
        ciphertext: input.ciphertext,
        createdAt: new Date(),
      });
      return { ok: true, newVersion };
    },

    async listKeyRecords(accountId: number): Promise<SyncKeyRecord[]> {
      return [...(keyRecordsByAccount.get(accountId)?.values() ?? [])];
    },

    async putKeyRecord(input): Promise<PutKeyRecordResult> {
      const accountRecords = keyRecordsByAccount.get(input.accountId) ?? new Map<SyncKeyRecordKind, SyncKeyRecord>();
      const existing = accountRecords.get(input.kind) ?? null;
      const existingUpdatedAt = existing?.updatedAt ?? null;

      const matches =
        input.expectedUpdatedAt === null
          ? existingUpdatedAt === null
          : existingUpdatedAt !== null && existingUpdatedAt.getTime() === input.expectedUpdatedAt.getTime();
      if (!matches) {
        return { ok: false, currentUpdatedAt: existingUpdatedAt };
      }

      const full: SyncKeyRecord = {
        accountId: input.accountId,
        kind: input.kind,
        kdfDescriptor: input.kdfDescriptor,
        wrappedDek: input.wrappedDek,
        updatedAt: new Date(),
      };
      accountRecords.set(input.kind, full);
      keyRecordsByAccount.set(input.accountId, accountRecords);
      return { ok: true, record: full };
    },

    async deleteKeyRecord(input): Promise<void> {
      keyRecordsByAccount.get(input.accountId)?.delete(input.kind);
    },
  };
}
