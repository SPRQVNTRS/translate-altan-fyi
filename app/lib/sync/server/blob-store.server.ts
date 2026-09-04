/**
 * The server side of the sync blob: read the user's document, or write a new
 * version under a compare-and-swap.
 *
 * THE COMPARE-AND-SWAP IS THE WHOLE POINT OF THIS FILE, and it is one
 * statement. A push carries the `baseVersion` the device last agreed with; the
 * write is an `INSERT ... ON CONFLICT (user_id) DO UPDATE ... WHERE
 * sync_blobs.blob_version = baseVersion`, so two devices racing off the same
 * base can both pass a read and only one can update a row. Zero rows updated
 * means the caller lost the race, which is reported as the CURRENT version so
 * the device can pull, merge and try again.
 *
 * The logic is what `app/lib/e2ee/push-handler.ts` and `pull-handler.ts` held
 * until M191, with the crypto fields removed: there is no `envelopeVersion` and
 * no ciphertext, and the payload is ordinary JSON the server may read.
 *
 * `.server.ts` because it imports the connection pool.
 */
import { eq, sql } from 'drizzle-orm';

import type { JsonValue } from '#app/lib/json';
import { getRawDb } from '#drizzle/db';
import { syncBlobs } from '#drizzle/schema';

/**
 * The largest document this service will store, in bytes of its JSON encoding.
 *
 * Two mebibytes. Measured against the local store's own growth, a heavy reader
 * reaches this in years rather than months, and the cliff has to be visible in
 * one place rather than discovered as an opaque database error.
 */
export const MAX_BLOB_BYTES = 2 * 1024 * 1024;

/** One stored document, as a pull hands it back. */
export interface StoredBlob {
  blobVersion: number;
  payload: JsonValue;
  createdAt: Date;
}

/** The three outcomes of a push. A conflict is a NORMAL outcome, not a failure. */
export type PutBlobResult =
  | { status: 'accepted'; newVersion: number }
  | { status: 'conflict'; currentVersion: number }
  | { status: 'invalid'; reason: string };

/**
 * The user's current document.
 *
 * @param userId whose document to read.
 * @returns the document, or `null` when this user has never pushed one.
 */
export async function readBlob(userId: number): Promise<StoredBlob | null> {
  const [row] = await getRawDb().select().from(syncBlobs).where(eq(syncBlobs.userId, userId)).limit(1);
  if (!row) return null;
  return { blobVersion: row.blobVersion, payload: row.payload, createdAt: row.createdAt };
}

/**
 * Writes a new version, if and only if the caller is up to date.
 *
 * @param input.userId whose document to write.
 * @param input.baseVersion the version the caller last agreed with. `0` asserts
 *   that this user has no document yet.
 * @param input.payload the document, already parsed from the request body.
 * @param input.sizeBytes the encoded size, measured by the caller that read the body.
 * @returns the accepted version, the current version on a lost race, or a refusal.
 */
export async function putBlobIfVersionMatches(input: {
  userId: number;
  baseVersion: number;
  payload: JsonValue;
  sizeBytes: number;
}): Promise<PutBlobResult> {
  if (!Number.isInteger(input.baseVersion) || input.baseVersion < 0) {
    return { status: 'invalid', reason: 'baseVersion must be a non-negative integer' };
  }
  if (input.sizeBytes > MAX_BLOB_BYTES) {
    return { status: 'invalid', reason: `blob exceeds the maximum of ${MAX_BLOB_BYTES} bytes` };
  }

  const newVersion = input.baseVersion + 1;
  const values = {
    userId: input.userId,
    blobVersion: newVersion,
    payload: input.payload,
    sizeBytes: input.sizeBytes,
  };

  const [row] = await getRawDb()
    .insert(syncBlobs)
    .values(values)
    .onConflictDoUpdate({
      target: syncBlobs.userId,
      set: { blobVersion: newVersion, payload: input.payload, sizeBytes: input.sizeBytes, createdAt: sql`now()` },
      // THE SWAP ITSELF. Without this clause the upsert would overwrite
      // whatever another device committed a millisecond earlier, and that
      // device's unsynced words would be gone with no error anywhere.
      setWhere: eq(syncBlobs.blobVersion, input.baseVersion),
    })
    .returning({ blobVersion: syncBlobs.blobVersion });

  if (row) return { status: 'accepted', newVersion: row.blobVersion };

  // Zero rows means the WHERE above did not match: somebody wrote first. Report
  // the real current version so the caller can merge against it.
  const current = await readBlob(input.userId);
  return { status: 'conflict', currentVersion: current?.blobVersion ?? 0 };
}

/**
 * The size of the user's stored document, for the account screen.
 *
 * @param userId whose document to measure.
 * @returns the byte count, or `null` when there is no document.
 */
export async function readBlobSizeBytes(userId: number): Promise<number | null> {
  const [row] = await getRawDb()
    .select({ sizeBytes: syncBlobs.sizeBytes })
    .from(syncBlobs)
    .where(eq(syncBlobs.userId, userId))
    .limit(1);
  return row?.sizeBytes ?? null;
}
