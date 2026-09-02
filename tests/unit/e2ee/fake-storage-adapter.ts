/**
 * In-memory fake `SyncStorageAdapter` for the key-record handler tests. It
 * implements the same CAS semantics a real backend must (see PROTOCOL.md
 * §10), so the handler tests exercise realistic behaviour — including the
 * conflict paths — without a database.
 *
 * TRIMMED ON COPY, with `contract-types.ts`: the blob half of the adapter is
 * gone because this repo has no `sync_blobs` yet.
 */
import type { PutKeyRecordResult, SyncKeyRecord, SyncStorageAdapter } from '#app/lib/e2ee/contract-types';
import type { SyncKeyRecordKind } from '#app/lib/e2ee/protocol';

export function createFakeStorageAdapter(): SyncStorageAdapter {
  const keyRecordsByAccount = new Map<number, Map<SyncKeyRecordKind, SyncKeyRecord>>();

  return {
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
