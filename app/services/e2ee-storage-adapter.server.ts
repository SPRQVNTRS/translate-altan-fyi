/**
 * The Drizzle `SyncStorageAdapter` — the encrypted blobs (`sync_blobs`) and
 * the wrapped-DEK records (`sync_key_records`) behind
 * `app/lib/e2ee/push-handler.ts`, `pull-handler.ts` and
 * `key-records-handler.ts`.
 *
 * NOT COPIED, and not under `app/lib/e2ee/`, but it now mirrors
 * `openplate-sync`'s `db/storage-adapter.ts` closely: both halves of that
 * file's adapter live here, and the concurrency discipline below is its,
 * carried across. It carries no provenance header all the same, because the
 * differences are not drift and a `git diff` should not have to argue about
 * them: the Drizzle handle defaults to this repo's `getRawDb()`, the tables
 * come from `#drizzle/schema`, and `bytea` reads are copied into a
 * `Uint8Array`. What IS copied verbatim is the contract it satisfies
 * (`contract-types.ts`) and the handlers that call it.
 *
 * THE COMPARE-AND-SWAP IS THE WHOLE POINT OF THIS FILE, and it is enforced by
 * a UNIQUE constraint, not by row locking. Every blob write computes
 * `newVersion = currentVersion + 1` and attempts an INSERT of that exact
 * `(accountId, newVersion)` pair. Two concurrent uploads racing the same
 * `baseVersion` can both pass the initial read, but only ONE insert can
 * possibly succeed — the loser hits a Postgres unique violation (23505,
 * caught by `app/lib/e2ee/storage-conflict.ts`) and is translated into the
 * same `{ ok: false, currentVersion }` a plain version mismatch would return.
 * This stays correct under READ COMMITTED (Postgres's default) and is simpler
 * than `SELECT ... FOR UPDATE`, with an identical caller-facing contract.
 *
 * The same discipline extends to key records: `expectedUpdatedAt` plays the
 * role `baseVersion` plays for blobs, gated by
 * `sync_key_records_account_kind_idx`. It is a token, not a hint: `null`
 * asserts "no record exists yet for this (account, kind)"; any other value
 * asserts "the record I last read had exactly this `updatedAt`". A mismatch
 * is a conflict and never a blind upsert, because a blind upsert here
 * overwrites the DEK wrap another device just committed and strands that
 * device's data permanently.
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
import { and, desc, eq, inArray } from 'drizzle-orm';

import type {
  PutBlobResult,
  PutKeyRecordResult,
  SyncBlobRecord,
  SyncKeyRecord,
  SyncStorageAdapter,
} from '#app/lib/e2ee/contract-types';
import type { SyncKeyRecordKind } from '#app/lib/e2ee/protocol';
import { BLOB_VERSION_RETENTION } from '#app/lib/e2ee/protocol';
import { isUniqueViolation } from '#app/lib/e2ee/storage-conflict';
import { syncBlobs, syncKeyRecords } from '#drizzle/schema';
import { getRawDb } from '#drizzle/db';

/**
 * A blob and a key record belong to an account, and `getRawDb()` is the one
 * handle this application has.
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
export function createDrizzleStorageAdapter(db: Database = getRawDb()): SyncStorageAdapter {
  /** The account's highest stored blob version, or `0` when it has never pushed one. */
  async function readCurrentBlobVersion(accountId: number): Promise<number> {
    const [row] = await db
      .select({ blobVersion: syncBlobs.blobVersion })
      .from(syncBlobs)
      .where(eq(syncBlobs.accountId, accountId))
      .orderBy(desc(syncBlobs.blobVersion))
      .limit(1);
    return row?.blobVersion ?? 0;
  }

  /** Deletes every blob version for `accountId` past the retention cap, oldest first. */
  async function pruneOldBlobVersions(accountId: number): Promise<void> {
    const rows = await db
      .select({ id: syncBlobs.id })
      .from(syncBlobs)
      .where(eq(syncBlobs.accountId, accountId))
      .orderBy(desc(syncBlobs.blobVersion));
    const staleIds = rows.slice(BLOB_VERSION_RETENTION).map((row) => row.id);
    if (staleIds.length === 0) return;
    await db.delete(syncBlobs).where(inArray(syncBlobs.id, staleIds));
  }

  async function readCurrentUpdatedAt(input: { accountId: number; kind: SyncKeyRecordKind }): Promise<Date | null> {
    const [row] = await db
      .select({ updatedAt: syncKeyRecords.updatedAt })
      .from(syncKeyRecords)
      .where(and(eq(syncKeyRecords.accountId, input.accountId), eq(syncKeyRecords.kind, input.kind)))
      .limit(1);
    return row?.updatedAt ?? null;
  }

  return {
    async getBlob(accountId: number): Promise<SyncBlobRecord | null> {
      const [row] = await db
        .select()
        .from(syncBlobs)
        .where(eq(syncBlobs.accountId, accountId))
        .orderBy(desc(syncBlobs.blobVersion))
        .limit(1);
      if (!row) return null;
      return {
        accountId: row.accountId,
        blobVersion: row.blobVersion,
        envelopeVersion: row.envelopeVersion,
        // `bytea` comes back as a Buffer, as `wrappedDek` above does; the
        // contract is a `Uint8Array` and the bytes are never inspected.
        ciphertext: new Uint8Array(row.ciphertext),
        createdAt: row.createdAt,
      };
    },

    async putBlobIfVersionMatches(input): Promise<PutBlobResult> {
      const currentVersion = await readCurrentBlobVersion(input.accountId);
      if (currentVersion !== input.baseVersion) {
        return { ok: false, currentVersion };
      }

      const newVersion = currentVersion + 1;
      try {
        await db.insert(syncBlobs).values({
          accountId: input.accountId,
          blobVersion: newVersion,
          envelopeVersion: input.envelopeVersion,
          ciphertext: Buffer.from(input.ciphertext),
          sizeBytes: input.ciphertext.byteLength,
        });
      } catch (error) {
        if (!isUniqueViolation(error)) throw error;
        // Lost the race to a concurrent upload — re-read and report the REAL
        // current version, same contract as a plain version mismatch.
        return { ok: false, currentVersion: await readCurrentBlobVersion(input.accountId) };
      }

      await pruneOldBlobVersions(input.accountId);
      return { ok: true, newVersion };
    },

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
