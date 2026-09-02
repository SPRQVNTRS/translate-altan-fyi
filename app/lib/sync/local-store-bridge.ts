/**
 * COPIED, NOT SHARED. Source: openplate/app/lib/sync/local-store-bridge.ts @ 68e893ac71d25ad7ff42280773ea0ec94f4f700e.
 * See .adr/0008-e2ee-sync-copied-not-extracted.md. Fixes belong upstream first,
 * then here. Do not let the two drift.
 */
/**
 * The ONLY seam between sync and the local store.
 *
 * Everything sync does to the device's data happens through the functions
 * `app/lib/local-store` already exports. No second write path, no direct
 * TinyBase access, no reaching past `persist.ts` into IndexedDB. That is not
 * politeness: those functions are what take `persist.ts`'s save lock, dedupe
 * autosaves and keep the schema-version value honest, and a parallel writer
 * would quietly bypass all three (see `sync-lock.ts` for the ordering rule
 * this preserves).
 *
 * Keeping the seam in one small file also makes the blast radius of a
 * local-store refactor exactly one import list.
 */
import type { Store } from 'tinybase';
import {
  listLocalListItemsIncludingDeleted,
  listLocalListsIncludingDeleted,
  listLocalNotesIncludingDeleted,
  listLocalReviewStateIncludingDeleted,
  syncedSnapshotSchema,
  toSyncedSnapshot,
  writeMergedSnapshot,
  SCHEMA_VERSION,
  type SyncedSnapshot,
} from '#app/lib/local-store';
import { SyncRequestError } from '#app/lib/e2ee/client/sync-error';

/** Options accepted by the reads here, the same shape every `local-store` function takes — the store defaults to the browser singleton. */
interface StoreOption {
  store?: Store;
}

/**
 * The device's synced rows, TOMBSTONES INCLUDED. A delete that is filtered out
 * here never reaches the peer, so the reads are the `IncludingDeleted` ones and
 * a tombstone travels as an ordinary row with `deleted: true`.
 *
 * WHAT LEAVES THE DEVICE IS `toSyncedSnapshot`'s DECISION, NOT THIS FUNCTION'S.
 * This assembles four reads and hands them to the projection rather than
 * building the payload itself, so there is one list of synced collection names
 * in the codebase instead of two that can drift. The collection this store
 * holds and the blob deliberately does not carry is named in
 * `app/lib/e2ee/BLOB-CONTENTS.md`; it is never read here, and could not survive
 * the projection if it were.
 *
 * `store` defaults to the browser IndexedDB singleton. It is injectable for one
 * reason: without it this function resolves that singleton and cannot run
 * outside a browser at all, so a test could only MIRROR the live path. With it,
 * a test drives this exact function against an in-memory store.
 */
export async function readLocalSnapshot({ store }: StoreOption = {}): Promise<SyncedSnapshot> {
  const [lists, listItems, notes, reviewState] = await Promise.all([
    listLocalListsIncludingDeleted({ store }),
    listLocalListItemsIncludingDeleted({ store }),
    listLocalNotesIncludingDeleted({ store }),
    listLocalReviewStateIncludingDeleted({ store }),
  ]);
  return toSyncedSnapshot({ lists, listItems, notes, reviewState });
}

/**
 * Validates a snapshot that arrived from another device.
 *
 * A NEWER SCHEMA IS A REFUSAL, NOT A BEST-EFFORT READ. `SCHEMA_VERSION` is 2,
 * and the v1 -> v2 bump needed no forward migration: it only ADDED the
 * review-state collection, and `syncedSnapshotSchema` defaults each collection
 * to empty, so a v1 blob reads as "the device that wrote this had no review
 * state". That is true, so this check is still the whole of the version
 * handling. A bump that reshapes a field would need a step, and it would go in
 * beside this guard. A blob written by a build that knows fields this one
 * does not cannot be read correctly here — every unknown field would be
 * dropped, and the drop would then be pushed back up as the new truth, so a
 * newer device's data would be silently deleted by an older one. Refusing
 * costs that device a sync until it updates; guessing costs it its data.
 *
 * @throws when the payload is not a valid snapshot. A refusal, not a warning:
 * writing a half-understood entity into someone's vocabulary list is worse
 * than not syncing.
 */
export function parseRemoteSnapshot({
  snapshot,
  schemaVersion,
}: {
  snapshot: unknown;
  schemaVersion: number;
}): SyncedSnapshot {
  if (schemaVersion > SCHEMA_VERSION) {
    throw new SyncRequestError({
      kind: 'invalid',
      message: 'This account’s synced data was written by a newer version of the app than this device is running.',
    });
  }
  const parsed = syncedSnapshotSchema.safeParse(snapshot);
  if (!parsed.success) {
    throw new SyncRequestError({
      kind: 'invalid',
      message: 'This account’s synced data is not in a shape this device can read.',
    });
  }
  return parsed.data;
}

/**
 * Writes the merged rows onto the device verbatim, stamps and tombstones
 * intact.
 *
 * NO DELETE PASS, AND A READER WHO KNOWS THE SOURCE SHOULD NOT GO LOOKING FOR
 * ONE. Upstream this function ran deletes first and then upserts, because
 * `importBackup` is upsert-only and an entity another device deleted would
 * otherwise survive here forever and be re-uploaded on the next cycle. Here
 * `writeMergedSnapshot` REPLACES the four synced tables wholesale in one
 * transaction, and a delete is an ordinary `deleted: true` row inside the
 * merge result, so the merged snapshot already says everything there is to say
 * about which rows exist.
 */
export async function applyMergedSnapshot({ merged }: { merged: SyncedSnapshot }): Promise<void> {
  await writeMergedSnapshot(merged);
}
