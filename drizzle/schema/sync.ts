/**
 * `sync_blobs`, the one document a signed-in device pushes and pulls.
 *
 * IT IS PLAIN JSON NOW, AND THE SERVER MAY READ IT (M191). This table used to
 * hold `ciphertext bytea` under an `envelope_version`, with a data key the
 * service could not derive. The encrypted layer is gone with the account model
 * that carried it, so the honest shape is a `jsonb` payload and a privacy page
 * that says the operator can read it. Nothing else about the contract moved:
 * the compare-and-swap on `blob_version` is unchanged, and it is still the
 * device's own store that is the source of truth.
 *
 * ONE CURRENT BLOB PER USER. The unique index below is on `user_id` alone, so
 * a push REPLACES the row rather than appending a version. The old table kept
 * the last five versions behind a `(account_id, blob_version)` unique index and
 * a prune step; there is no reader for an old version and no way to hand one
 * back, so the retention was storage nobody could use.
 *
 * EVERY READ OR WRITE GOES THROUGH `getRawDb()`.
 */
import { relations, type InferInsertModel, type InferSelectModel } from 'drizzle-orm';
import { integer, jsonb, pgTable, serial, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';

import type { JsonValue } from '#app/lib/json';
import { users } from './users';

export const syncBlobs = pgTable(
  'sync_blobs',
  {
    id: serial('id').primaryKey(),
    /**
     * `onDelete: 'cascade'` is the erasure mechanism: deleting a user removes
     * their blob in the same statement, with no cleanup job to forget to run.
     */
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /**
     * Monotonic per-user version, and the compare-and-swap token. A push is
     * accepted only when its `baseVersion` equals the stored value, `0`
     * asserting "this user has no blob yet"; a stale push is a `409`, never a
     * blind overwrite that would discard another device's unsynced changes.
     */
    blobVersion: integer('blob_version').notNull(),
    /** The device's snapshot and its sync metadata, exactly as `app/lib/sync/` frames it. */
    payload: jsonb('payload').$type<JsonValue>().notNull(),
    /** Redundant with `payload`'s own size, but avoids reading a large document just to report storage usage. */
    sizeBytes: integer('size_bytes').notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  // ONE ROW PER USER, and the index is what enforces it rather than the
  // application: two concurrent first pushes can both pass a read-then-insert
  // check, and only one INSERT of the same `user_id` can survive.
  (table) => [uniqueIndex('sync_blobs_user_idx').on(table.userId)],
);

export type InsertSyncBlob = InferInsertModel<typeof syncBlobs>;
export type SelectSyncBlob = InferSelectModel<typeof syncBlobs>;

export const syncBlobsRelations = relations(syncBlobs, ({ one }) => ({
  user: one(users, { fields: [syncBlobs.userId], references: [users.id] }),
}));
