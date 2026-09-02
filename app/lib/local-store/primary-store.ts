/**
 * COPIED, NOT SHARED. Source: openplate/app/lib/local-store/primary-store.ts @ 68e893a.
 * See .adr/0008-e2ee-sync-copied-not-extracted.md. Fixes belong upstream first,
 * then here. Do not let the two drift.
 *
 * The primary store's read/write surface — CRUD over the durable, authoritative
 * on-device tables (lists, list items, notes). This is the "primary commit"
 * every screen writes to and the source the backup (`backup.ts`) and the sync
 * projection (`blob-schema.ts`) read from. The device-only search log has its
 * own module (`history.ts`), because its deletion semantics differ.
 *
 * Every entity is stored as ONE JSON cell per row (keyed by the entity's `id`),
 * so a row is read/written whole. Reads return entities in a stable order (by
 * id) so a backup round-trip is deterministic. The store is injectable
 * (defaults to the IndexedDB-backed singleton) so the pure logic and its unit
 * tests run against a real in-memory store with no browser.
 *
 * CRITICAL: no function here ever evicts. This store is primary, not a bounded
 * cache — a write never deletes another row. The only deletes are the explicit
 * per-id `deleteLocal*` functions, and they are SOFT.
 *
 * ---------------------------------------------------------------------------
 * THE STAMP IS APPLIED BY THE WRITE HELPERS, AND THAT IS A DELIBERATE
 * DIVERGENCE FROM THE SOURCE.
 *
 * Upstream, the write paths know nothing about sync: `snapshot-sync.ts`
 * re-derives every entity's `(lamport, deviceId)` on each cycle by diffing
 * content hashes against a persisted baseline. That is the right call THERE.
 * openplate is a large existing app with many write paths, and threading a
 * bump call through all of them would put the sync layer in the blast radius
 * of every future feature that writes a row.
 *
 * Here the write paths are NEW, and there are three of them. So the stamp is
 * applied at the write, in one place: every `putLocal*` and `deleteLocal*`
 * below sets `{ lamport, deviceId, updatedAt, deleted }` itself, and no caller
 * passes them. The failure mode is the same either way — one missed call site
 * and an entity never converges — but three call sites in one module is a
 * smaller surface to keep correct than a hash baseline that must stay in step
 * with the store it is measuring.
 * ---------------------------------------------------------------------------
 */
import type { Store } from 'tinybase';
import { z } from 'zod';
import {
  LISTS_TABLE,
  LIST_ITEMS_TABLE,
  NOTES_TABLE,
  PRIMARY_ENTITY_CELL,
  SCHEMA_VERSION_VALUE,
  DEVICE_ID_VALUE,
} from './store';
import { getPrimaryStore, requestPersistentStorage } from './persist';
import { SCHEMA_VERSION } from './schema';
import type { LocalList, LocalListItem, LocalNote, SyncStamp } from './schema';
import type { SyncedSnapshot } from './blob-schema';

/** Every entity kind this store persists as one JSON cell per row. */
type PrimaryEntity = LocalList | LocalListItem | LocalNote;

/** A list as a caller supplies it — the stamp is this module's to apply, never the caller's. */
export type LocalListInput = Omit<LocalList, keyof SyncStamp>;
/** A list item as a caller supplies it. */
export type LocalListItemInput = Omit<LocalListItem, keyof SyncStamp>;
/** A note as a caller supplies it. */
export type LocalNoteInput = Omit<LocalNote, keyof SyncStamp>;

/** The entity cell as it comes back off the store — a TinyBase cell, not yet JSON text. */
const entityCellSchema = z.string();

/** This device's id as it comes back off the store — a TinyBase value, not yet an id. */
const deviceIdValueSchema = z.string().min(1);

/** Options accepted by every primary-store function — the store defaults to the singleton. */
interface StoreOption {
  store?: Store;
}

/**
 * Options accepted by every WRITE. `now` and `deviceId` are injectable so a
 * unit test can assert an exact stamp instead of a moving one; both default to
 * the real thing.
 */
interface WriteOption extends StoreOption {
  now?: () => number;
  deviceId?: string;
}

async function resolveStore(store: Store | undefined): Promise<Store> {
  return store ?? (await getPrimaryStore());
}

// ---------------------------------------------------------------------------
// Generic row (de)serialization
// ---------------------------------------------------------------------------

/**
 * Writes one entity as a JSON cell, and (on a real browser) requests persistent
 * storage — this is the "first write" durability trigger. Stamps the schema
 * version the store was last written under, so a future migration can detect
 * the on-disk shape.
 */
function writeEntity(store: Store, table: string, id: string, entity: PrimaryEntity): void {
  requestPersistentStorage();
  store.setValue(SCHEMA_VERSION_VALUE, SCHEMA_VERSION);
  store.setRow(table, id, { [PRIMARY_ENTITY_CELL]: JSON.stringify(entity) });
}

/** Parses one row's entity cell, or null when absent/corrupt (never throws). */
function readEntity<T>(store: Store, table: string, id: string): T | null {
  if (!store.hasRow(table, id)) return null;
  const raw = entityCellSchema.safeParse(store.getCell(table, id, PRIMARY_ENTITY_CELL));
  if (!raw.success) return null;
  try {
    // SAFETY: this cell is written only by `writeEntity` above, which stores
    // `JSON.stringify` of the very `PrimaryEntity` kind each caller reads back
    // for its own table. A malformed/foreign value throws and is caught.
    return JSON.parse(raw.data) as T;
  } catch {
    return null;
  }
}

/** Every entity in a table, corrupt rows skipped. Unordered — callers sort. */
function readEntities<T>(store: Store, table: string): T[] {
  return store
    .getRowIds(table)
    .map((id) => readEntity<T>(store, table, id))
    .filter((entity): entity is T => entity !== null);
}

/**
 * Stable order for a backup-safe, deterministic read. The id is the whole key
 * here rather than a `createdAt` tiebreak: a synced entity has no creation
 * instant, only a stamp, and `updatedAt` is explicitly not an ordering
 * authority (see `SyncStamp`).
 */
function byId<T extends { id: string }>(a: T, b: T): number {
  return a.id.localeCompare(b.id);
}

/** The rows a reader may see: a tombstone is still a row, and must never reach a screen. */
function isLive<T extends SyncStamp>(entity: T): boolean {
  return !entity.deleted;
}

// ---------------------------------------------------------------------------
// Device id
// ---------------------------------------------------------------------------

/**
 * This device's stable id, the second half of the (lamport, deviceId) tie-break.
 *
 * It lives as a store VALUE in the primary IndexedDB store rather than in
 * `localStorage`, so it shares the lifetime of the data it stamps: a browser
 * that clears site storage clears both, and a device cannot come back holding
 * an id whose entities are gone.
 *
 * It only has to be UNIQUE and STABLE. It is not an identifier of a person: it
 * is per browser profile, carries nothing derived from the user, and travels
 * only inside encrypted blobs.
 */
export async function resolveDeviceId(options: StoreOption = {}): Promise<string> {
  const store = await resolveStore(options.store);
  const existing = deviceIdValueSchema.safeParse(store.getValue(DEVICE_ID_VALUE));
  if (existing.success) return existing.data;
  const minted = crypto.randomUUID();
  store.setValue(DEVICE_ID_VALUE, minted);
  return minted;
}

// ---------------------------------------------------------------------------
// Stamping
// ---------------------------------------------------------------------------

/**
 * The next Lamport value for a local edit: `max(seen) + 1`. `seen` should
 * include every lamport value this device currently knows about for the entity
 * being edited (typically just its own current stamp, but a freshly-merged
 * entity might have a HIGHER stamp than this device has ever issued —
 * reconciling to `max(seen)+1` on merge, not just `own+1`, is what keeps this
 * a genuine Lamport clock rather than a per-device counter).
 */
export function nextLamport(seen: readonly number[]): number {
  return Math.max(0, ...seen) + 1;
}

/** The lamport currently stamped on a row, or 0 when the row is absent or unreadable. */
function currentLamport(store: Store, table: string, id: string): number {
  return readEntity<SyncStamp>(store, table, id)?.lamport ?? 0;
}

/** Builds the stamp for one write, bumping the row's own lamport and marking it live or dead. */
async function nextStamp(
  store: Store,
  table: string,
  id: string,
  deleted: boolean,
  options: WriteOption,
): Promise<SyncStamp> {
  const now = options.now ?? Date.now;
  return {
    lamport: nextLamport([currentLamport(store, table, id)]),
    deviceId: options.deviceId ?? (await resolveDeviceId({ store })),
    updatedAt: now(),
    deleted,
  };
}

/**
 * Soft-deletes one row: the entity stays, `deleted` flips to true and the
 * lamport bumps, so the tombstone can win a merge against a peer that still
 * holds the live row. A hard delete would let that peer's copy resurrect the
 * entity on the next pull.
 *
 * A row that was never there is left alone: there is nothing to tombstone, and
 * writing one would invent an entity purely to declare it gone.
 */
async function softDelete(table: string, id: string, options: WriteOption): Promise<void> {
  const store = await resolveStore(options.store);
  const existing = readEntity<PrimaryEntity>(store, table, id);
  if (!existing) return;
  writeEntity(store, table, id, { ...existing, ...(await nextStamp(store, table, id, true, options)) });
}

// ---------------------------------------------------------------------------
// Lists
// ---------------------------------------------------------------------------

/** Upserts a vocabulary list (keyed by `id`), stamping it for sync. */
export async function putLocalList(list: LocalListInput, options: WriteOption = {}): Promise<LocalList> {
  const store = await resolveStore(options.store);
  const stamped: LocalList = { ...list, ...(await nextStamp(store, LISTS_TABLE, list.id, false, options)) };
  writeEntity(store, LISTS_TABLE, list.id, stamped);
  return stamped;
}

/** Every live vocabulary list, id order. Tombstones are filtered out. */
export async function listLocalLists({ store }: StoreOption = {}): Promise<LocalList[]> {
  return readEntities<LocalList>(await resolveStore(store), LISTS_TABLE)
    .filter(isLive)
    .toSorted(byId);
}

/** Every list INCLUDING tombstones — the sync path's read, which must carry the deletions too. */
export async function listLocalListsIncludingDeleted({ store }: StoreOption = {}): Promise<LocalList[]> {
  return readEntities<LocalList>(await resolveStore(store), LISTS_TABLE).toSorted(byId);
}

/** One live list by id, or null. A tombstoned row reads as absent, exactly as it does in `listLocalLists`. */
export async function getLocalList(id: string, { store }: StoreOption = {}): Promise<LocalList | null> {
  const list = readEntity<LocalList>(await resolveStore(store), LISTS_TABLE, id);
  return list && isLive(list) ? list : null;
}

/** Soft-deletes one list by id — see {@link softDelete}. */
export async function deleteLocalList(id: string, options: WriteOption = {}): Promise<void> {
  await softDelete(LISTS_TABLE, id, options);
}

// ---------------------------------------------------------------------------
// List items
// ---------------------------------------------------------------------------

/** Upserts a list entry (keyed by `id`), stamping it for sync. */
export async function putLocalListItem(item: LocalListItemInput, options: WriteOption = {}): Promise<LocalListItem> {
  const store = await resolveStore(options.store);
  const stamped: LocalListItem = {
    ...item,
    ...(await nextStamp(store, LIST_ITEMS_TABLE, item.id, false, options)),
  };
  writeEntity(store, LIST_ITEMS_TABLE, item.id, stamped);
  return stamped;
}

/** Every live list entry, id order. Tombstones are filtered out. */
export async function listLocalListItems({ store }: StoreOption = {}): Promise<LocalListItem[]> {
  return readEntities<LocalListItem>(await resolveStore(store), LIST_ITEMS_TABLE)
    .filter(isLive)
    .toSorted(byId);
}

/** Every list entry INCLUDING tombstones — the sync path's read. */
export async function listLocalListItemsIncludingDeleted({ store }: StoreOption = {}): Promise<LocalListItem[]> {
  return readEntities<LocalListItem>(await resolveStore(store), LIST_ITEMS_TABLE).toSorted(byId);
}

/** One live list entry by id, or null. */
export async function getLocalListItem(id: string, { store }: StoreOption = {}): Promise<LocalListItem | null> {
  const item = readEntity<LocalListItem>(await resolveStore(store), LIST_ITEMS_TABLE, id);
  return item && isLive(item) ? item : null;
}

/** Soft-deletes one list entry by id — see {@link softDelete}. */
export async function deleteLocalListItem(id: string, options: WriteOption = {}): Promise<void> {
  await softDelete(LIST_ITEMS_TABLE, id, options);
}

// ---------------------------------------------------------------------------
// Notes
// ---------------------------------------------------------------------------

/** Upserts a note (keyed by `id`), stamping it for sync. */
export async function putLocalNote(note: LocalNoteInput, options: WriteOption = {}): Promise<LocalNote> {
  const store = await resolveStore(options.store);
  const stamped: LocalNote = { ...note, ...(await nextStamp(store, NOTES_TABLE, note.id, false, options)) };
  writeEntity(store, NOTES_TABLE, note.id, stamped);
  return stamped;
}

/** Every live note, id order. Tombstones are filtered out. */
export async function listLocalNotes({ store }: StoreOption = {}): Promise<LocalNote[]> {
  return readEntities<LocalNote>(await resolveStore(store), NOTES_TABLE)
    .filter(isLive)
    .toSorted(byId);
}

/** Every note INCLUDING tombstones — the sync path's read. */
export async function listLocalNotesIncludingDeleted({ store }: StoreOption = {}): Promise<LocalNote[]> {
  return readEntities<LocalNote>(await resolveStore(store), NOTES_TABLE).toSorted(byId);
}

/** One live note by id, or null. */
export async function getLocalNote(id: string, { store }: StoreOption = {}): Promise<LocalNote | null> {
  const note = readEntity<LocalNote>(await resolveStore(store), NOTES_TABLE, id);
  return note && isLive(note) ? note : null;
}

/** Soft-deletes one note by id — see {@link softDelete}. */
export async function deleteLocalNote(id: string, options: WriteOption = {}): Promise<void> {
  await softDelete(NOTES_TABLE, id, options);
}

// ---------------------------------------------------------------------------
// Tombstone compaction
// ---------------------------------------------------------------------------

/**
 * Hard-removes every tombstone last written before `cutoffMs`, across all three
 * synced tables. Returns how many rows went.
 *
 * NOTHING CALLS THIS YET, on purpose. A tombstone may only be dropped once
 * every device that might not have seen it has had a chance to pull it, and
 * this module cannot know that: it is a policy decision for the sync
 * orchestrator, which knows when the last successful cycle was. The function
 * exists so that decision has one place to land, not so a caller can guess a
 * cutoff today.
 *
 * `updatedAt` is the age measure here even though it is not an ordering
 * authority. That is sound because compaction is a LOCAL housekeeping choice
 * about this device's own disk, not a convergence decision: a clock that is
 * wrong makes this device compact too early or too late, and the cutoff the
 * caller chooses is what bounds the damage.
 */
export async function purgeDeletedBefore(cutoffMs: number, { store }: StoreOption = {}): Promise<number> {
  const resolved = await resolveStore(store);
  let purged = 0;
  for (const table of [LISTS_TABLE, LIST_ITEMS_TABLE, NOTES_TABLE]) {
    for (const id of resolved.getRowIds(table)) {
      const entity = readEntity<SyncStamp>(resolved, table, id);
      if (!entity || !entity.deleted || entity.updatedAt >= cutoffMs) continue;
      resolved.delRow(table, id);
      purged += 1;
    }
  }
  return purged;
}

// ---------------------------------------------------------------------------
// The merge write path
// ---------------------------------------------------------------------------

/**
 * Writes rows a sync merge has already resolved, VERBATIM.
 *
 * The stamp arrives with the row and is written as it stands. This is the one
 * write path that does not call `nextLamport`, and the distinction is
 * load-bearing: `putLocalList` and its siblings stamp a LOCAL edit with this
 * device and a fresh counter, which is exactly what an adopted row must not
 * get. Re-stamping here would make this device claim a peer's write, so its
 * copy would outrank the peer's original on the next cycle and the two would
 * never converge.
 *
 * Tombstones are written too, not skipped. A `deleted` row is how a delete
 * travels, and dropping it here would resurrect the entity on the next push.
 *
 * The three synced tables are replaced WHOLESALE with exactly the rows given —
 * a merge result is a statement about the whole collection, so a row absent
 * from it is a row that must be absent here. All of it happens in ONE TinyBase
 * transaction, so a concurrent read can never observe a half-applied merge, and
 * the whole adoption costs one autosave rather than one per row.
 *
 * The device-only search log is untouched: it is not in the snapshot, and it
 * never will be (`app/lib/e2ee/BLOB-CONTENTS.md`).
 */
export async function writeMergedSnapshot(snapshot: SyncedSnapshot, { store }: StoreOption = {}): Promise<void> {
  const resolved = await resolveStore(store);
  requestPersistentStorage();
  resolved.transaction(() => {
    resolved.setValue(SCHEMA_VERSION_VALUE, SCHEMA_VERSION);
    replaceTable(resolved, LISTS_TABLE, snapshot.lists);
    replaceTable(resolved, LIST_ITEMS_TABLE, snapshot.listItems);
    replaceTable(resolved, NOTES_TABLE, snapshot.notes);
  });
}

/** Replaces one table's whole content with `entities`, stamp included, exactly as given. */
function replaceTable(store: Store, table: string, entities: readonly PrimaryEntity[]): void {
  store.delTable(table);
  for (const entity of entities) {
    store.setRow(table, entity.id, { [PRIMARY_ENTITY_CELL]: JSON.stringify(entity) });
  }
}
