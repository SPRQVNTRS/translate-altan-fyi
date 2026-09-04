/**
 * ONE READ: how many bytes of encrypted data an account currently keeps on the
 * server, for the `/account` screen to report.
 *
 * IT READS `size_bytes` AND NEVER `ciphertext`. That column exists for exactly
 * this reason (`drizzle/schema/accounts.ts`): a blob can be 2 MiB, and pulling
 * it into the server process to measure its length would cost a megabyte of
 * transfer and memory per page view for a number the row already carries. The
 * storage adapter's `getBlob` selects the whole row, so it is the wrong call
 * here even though it reads the same table.
 *
 * SEPARATE MODULE, NOT A METHOD ON THE STORAGE ADAPTER, on purpose.
 * `app/services/e2ee-storage-adapter.server.ts` is a close mirror of
 * `openplate-sync`'s `db/storage-adapter.ts` (ADR-0008), and this read has no
 * upstream counterpart: it serves a screen that only this repo has. Adding it
 * there would put a local-only method into the file whose value is that its
 * differences from upstream are known and few, and a drift check would then
 * have to argue about a difference that is not drift.
 *
 * A blob belongs to an account, and `getRawDb()` is the one handle this
 * application has.
 *
 * `.server.ts` because it touches the connection pool.
 */
import { desc, eq } from 'drizzle-orm';

import { syncBlobs } from '#drizzle/schema';
import { getRawDb } from '#drizzle/db';

/**
 * The size of the account's newest stored blob.
 *
 * @param accountId the account whose usage to report.
 * @returns the byte count of the highest stored `blobVersion`, or `null` when
 *   the account has never pushed a blob. `null` is the "nothing synced yet"
 *   state and is not the same fact as `0`.
 */
export async function readLatestBlobSizeBytes(accountId: number): Promise<number | null> {
  const [row] = await getRawDb()
    .select({ sizeBytes: syncBlobs.sizeBytes })
    .from(syncBlobs)
    .where(eq(syncBlobs.accountId, accountId))
    .orderBy(desc(syncBlobs.blobVersion))
    .limit(1);
  return row?.sizeBytes ?? null;
}
