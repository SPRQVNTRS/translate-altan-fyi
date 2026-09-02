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
import {
  listLocalListItemsIncludingDeleted,
  listLocalListsIncludingDeleted,
  listLocalNotesIncludingDeleted,
  syncedSnapshotSchema,
  writeMergedSnapshot,
  SCHEMA_VERSION,
  type SyncedSnapshot,
} from '#app/lib/local-store';
import { SyncRequestError } from '#app/lib/e2ee/client/sync-error';

/** The device's synced rows, TOMBSTONES INCLUDED. A delete that is filtered out here never reaches the peer. */
export async function readLocalSnapshot(): Promise<SyncedSnapshot> {
  const [lists, listItems, notes] = await Promise.all([
    listLocalListsIncludingDeleted(),
    listLocalListItemsIncludingDeleted(),
    listLocalNotesIncludingDeleted(),
  ]);
  return { lists, listItems, notes };
}

/**
 * Validates a snapshot that arrived from another device.
 *
 * A NEWER SCHEMA IS A REFUSAL, NOT A BEST-EFFORT READ. `SCHEMA_VERSION` is 1,
 * so there is no forward migration to run yet and this check is the whole of
 * the version handling. A blob written by a build that knows fields this one
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
 * `writeMergedSnapshot` REPLACES the three synced tables wholesale in one
 * transaction, and a delete is an ordinary `deleted: true` row inside the
 * merge result, so the merged snapshot already says everything there is to say
 * about which rows exist.
 */
export async function applyMergedSnapshot({ merged }: { merged: SyncedSnapshot }): Promise<void> {
  await writeMergedSnapshot(merged);
}
