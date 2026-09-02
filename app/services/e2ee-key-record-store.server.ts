/**
 * The Drizzle `SyncStorageAdapter` — the wrapped-DEK records
 * (`sync_key_records`) behind `app/lib/e2ee/key-records-handler.ts`.
 *
 * NOT COPIED, and not under `app/lib/e2ee/`. Upstream this lives in
 * `openplate-sync`'s `db/storage-adapter.ts` alongside the sync-blob half,
 * which this repo does not have; carrying a provenance header over a file that
 * implements a third of its source would make the drift check
 * (ADR-0008) read a difference that is not one. What IS copied is the
 * contract it satisfies (`contract-types.ts`) and the handler that calls it.
 *
 * THE COMPARE-AND-SWAP IS THE WHOLE POINT OF THIS FILE. `expectedUpdatedAt`
 * is a token, not a hint: `null` asserts "no record exists yet for this
 * (account, kind)"; any other value asserts "the record I last read had
 * exactly this `updatedAt`". A mismatch is a conflict and never a blind
 * upsert, because a blind upsert here overwrites the DEK wrap another device
 * just committed and strands that device's data permanently.
 *
 * MILLISECOND PRECISION IS LOAD-BEARING, and the column already enforces it
 * (`drizzle/schema/accounts.ts` declares `timestamp(3)`). The CAS token leaves
 * here as an ISO-8601 string, which carries milliseconds; Postgres's `now()`
 * carries microseconds. While the column was a bare `timestamp` the value a
 * client read back was a truncation of the value stored, exact equality
 * matched zero rows, and every rotation 409'd forever (openplate-sync M160
 * spec 06). Nothing in this file may reintroduce a timestamp it did not get
 * from the database.
 *
 * `.server.ts` because it imports the connection pool.
 */
import { and, eq } from 'drizzle-orm';

import type { PutKeyRecordResult, SyncKeyRecord, SyncStorageAdapter } from '#app/lib/e2ee/contract-types';
import type { SyncKeyRecordKind } from '#app/lib/e2ee/protocol';
import { isUniqueViolation } from '#app/lib/e2ee/storage-conflict';
import { syncKeyRecords } from '#drizzle/schema';
import { getRawDb } from '#drizzle/tenant-db';

/**
 * `sync_key_records` is a GLOBAL table: it carries no `organizationId` and is
 * not in `TENANT_TABLES`, so the raw handle is the sanctioned reach rather
 * than a bypass of `tenantDb(ctx)` (ADR-0003). A key record belongs to an
 * account, and an account belongs to no organization.
 */
type Database = ReturnType<typeof getRawDb>;

type KeyRecordRow = typeof syncKeyRecords.$inferSelect;

function mapRow(row: KeyRecordRow): SyncKeyRecord {
  return {
    accountId: row.accountId,
    kind: row.kind,
    kdfDescriptor: row.kdfDescriptor,
    // `bytea` comes back as a Buffer; the contract is a `Uint8Array` and the
    // bytes are never inspected on either side.
    wrappedDek: new Uint8Array(row.wrappedDek),
    updatedAt: row.updatedAt,
  };
}

/**
 * @param db the Drizzle handle. Defaults to the raw one, which is what the
 *   application always wants; the parameter exists so an integration test can
 *   hand in a handle bound to its own database.
 * @returns the adapter `key-records-handler.ts` is written against.
 */
export function createDrizzleKeyRecordStore(db: Database = getRawDb()): SyncStorageAdapter {
  async function readCurrentUpdatedAt(input: { accountId: number; kind: SyncKeyRecordKind }): Promise<Date | null> {
    const [row] = await db
      .select({ updatedAt: syncKeyRecords.updatedAt })
      .from(syncKeyRecords)
      .where(and(eq(syncKeyRecords.accountId, input.accountId), eq(syncKeyRecords.kind, input.kind)))
      .limit(1);
    return row?.updatedAt ?? null;
  }

  return {
    async listKeyRecords(accountId: number): Promise<SyncKeyRecord[]> {
      const rows = await db.select().from(syncKeyRecords).where(eq(syncKeyRecords.accountId, accountId));
      return rows.map(mapRow);
    },

    async putKeyRecord(input): Promise<PutKeyRecordResult> {
      const values = {
        accountId: input.accountId,
        kind: input.kind,
        kdfDescriptor: input.kdfDescriptor,
        wrappedDek: Buffer.from(input.wrappedDek),
      };

      // FIRST-TIME CREATE. A plain INSERT, so the unique index on
      // `(account_id, kind)` is what enforces "no record should exist yet" —
      // never a read-then-insert check, which two concurrent first writes
      // would both pass. A unique violation IS the conflict.
      if (input.expectedUpdatedAt === null) {
        try {
          const [row] = await db.insert(syncKeyRecords).values(values).returning();
          if (!row) throw new Error('Failed to insert key record');
          return { ok: true, record: mapRow(row) };
        } catch (error) {
          if (!isUniqueViolation(error)) throw error;
          return { ok: false, currentUpdatedAt: await readCurrentUpdatedAt(input) };
        }
      }

      // ROTATION. The `updatedAt` equality in the WHERE clause is the swap:
      // zero rows means somebody else wrote between the caller's read and this
      // statement, so the caller's re-wrap is against a DEK state that no
      // longer exists.
      //
      // `updatedAt` is set explicitly rather than left to `$onUpdate`, because
      // a rotation that re-writes the SAME bytes must still move the token —
      // otherwise a caller could replay one write forever.
      const [row] = await db
        .update(syncKeyRecords)
        .set({ kdfDescriptor: values.kdfDescriptor, wrappedDek: values.wrappedDek, updatedAt: new Date() })
        .where(
          and(
            eq(syncKeyRecords.accountId, input.accountId),
            eq(syncKeyRecords.kind, input.kind),
            eq(syncKeyRecords.updatedAt, input.expectedUpdatedAt),
          ),
        )
        .returning();

      if (!row) return { ok: false, currentUpdatedAt: await readCurrentUpdatedAt(input) };
      return { ok: true, record: mapRow(row) };
    },

    async deleteKeyRecord(input: { accountId: number; kind: SyncKeyRecordKind }): Promise<void> {
      await db
        .delete(syncKeyRecords)
        .where(and(eq(syncKeyRecords.accountId, input.accountId), eq(syncKeyRecords.kind, input.kind)));
    },
  };
}
