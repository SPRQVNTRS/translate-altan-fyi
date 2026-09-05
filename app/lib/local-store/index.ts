/**
 * The local-first data layer (TinyBase) — public surface.
 *
 * THE DEVICE OWNS THE DATA. TinyBase holds it, in IndexedDB, on this browser
 * profile. Every screen reads it from there and never from the network: a list,
 * an entry in a list, a note and the search log are all local reads, so they
 * work with no account, no connection and no server round trip. An account does
 * not unlock the data and does not store it; it decides one thing only, which
 * is whether the store ALSO REPLICATES to another device of the same person,
 * through an encrypted blob the server cannot read.
 *
 * SEARCH HISTORY IS CAPPED ON THE DEVICE AND STAYS THERE. It is the one
 * collection that never enters the blob. Two independent reasons, either
 * sufficient, are in `app/lib/local-store/BLOB-CONTENTS.md`; the cap itself is in
 * `history.ts`, applied on every write rather than on a schedule.
 *
 * CONFLICT STANCE: LAST-WRITE-WINS, per entity, on `(lamport, deviceId)`.
 * `app/lib/sync/engine/envelope/` frames the entities for the wire and
 * `snapshot-sync.ts` owns the merge. Wall-clock time is never the ordering
 * authority — `updatedAt` exists for the UI and for
 * local housekeeping, and nothing else.
 *
 * DEVICE SCOPE. The store is DEVICE-scoped, not account-scoped: one flat
 * IndexedDB database per browser profile, with no per-account namespacing
 * anywhere below. A shared device should use separate browser profiles per
 * person; that is the isolation boundary, and the only one.
 *
 * IMPORTING is always SSR-safe: store access is lazy, so importing this module
 * from a route (whose server loader runs in Node) has no top-level side
 * effects. CALLING a `getXStore()` singleton is NOT server-safe — resolving one
 * outside a browser with IndexedDB throws loudly (`persist.ts`'s
 * `assertBrowserWithIndexedDb`), rather than silently sharing one in-memory
 * store across every request and user. Server-side code, and unit tests, must
 * construct a store directly (`createPrimaryStore()` / `createOutboxStore()`)
 * and pass it via `{ store }`.
 *
 * WHY A STORE HANDLE IS EXPORTED AT ALL. `getPrimaryStore` is below because
 * the sync scheduler must SUBSCRIBE to writes, and a subscription is neither a
 * read nor a write, so none of the entity functions can express it. That is
 * the only legitimate reason to hand out the store. Everything that changes
 * data still goes through the functions here, which are what take `persist.ts`'s
 * save lock — a caller taking the handle to write with it bypasses the lock
 * and is the parallel writer `local-store-bridge.ts` exists to prevent.
 *
 * The code below is COPIED from openplate rather than shared, per
 * `.adr/0008-e2ee-sync-copied-not-extracted.md`. Each file names its source
 * path and commit. Fixes go upstream first, then here.
 */

// Versioned schema: the constant, the ids, and the entity/snapshot types.
export {
  SCHEMA_VERSION,
  HISTORY_CAP,
  HISTORY_MAX_ENTRIES,
  HISTORY_MAX_AGE_DAYS,
  LISTS_TABLE,
  LIST_ITEMS_TABLE,
  NOTES_TABLE,
  REVIEW_STATE_TABLE,
  FAVORITES_TABLE,
  HISTORY_TABLE,
} from './schema';
export type {
  SyncStamp,
  LocalList,
  LocalListItem,
  LocalNote,
  LocalReviewState,
  LocalFavorite,
  LocalHistoryEntry,
  LocalStoreSnapshot,
} from './schema';

// Store factories and database names — what a test or a server-side caller
// needs to build a store instead of resolving the browser singleton.
export { createPrimaryStore, createOutboxStore, PRIMARY_DB_NAME, OUTBOX_DB_NAME } from './store';

// The browser singleton handle, for SUBSCRIBING only — see the module doc.
export { getPrimaryStore } from './persist';

// Removing this device's copy, which sign-out and nothing else does.
export { wipeDeviceStore } from './wipe';

// Primary store: the authoritative on-device home for the synced entities. The
// write helpers own the sync stamp — see `primary-store.ts`'s module doc.
export {
  putLocalList,
  listLocalLists,
  listLocalListsIncludingDeleted,
  getLocalList,
  deleteLocalList,
  putLocalListItem,
  listLocalListItems,
  listLocalListItemsIncludingDeleted,
  getLocalListItem,
  deleteLocalListItem,
  putLocalNote,
  listLocalNotes,
  listLocalNotesIncludingDeleted,
  getLocalNote,
  deleteLocalNote,
  putLocalReviewState,
  listLocalReviewState,
  listLocalReviewStateIncludingDeleted,
  getLocalReviewState,
  deleteLocalReviewState,
  purgeDeletedBefore,
  writeMergedSnapshot,
  resolveDeviceId,
  nextLamport,
} from './primary-store';
export type { LocalListInput, LocalListItemInput, LocalNoteInput, LocalReviewStateInput } from './primary-store';

// Favourites: a saved word, kept with one tap. Synced like a list, and its own
// module because the id is DERIVED from `(headwordId, senseId, to)` rather than
// minted by the caller — which is what makes a second save of one word an
// overwrite instead of a duplicate row. See `favorites.ts`.
export {
  putFavorite,
  removeFavorite,
  listFavorites,
  listFavoritesIncludingDeleted,
  getFavorite,
  isFavorite,
  favoriteId,
} from './favorites';
export type { LocalFavoriteInput } from './favorites';

// The device-only search log, capped on every write and never synced.
export { recordSearch, listHistory, clearHistory, pruneHistory, importHistoryEntries } from './history';
export type { RecordSearchInput } from './history';

// The projection onto what the encrypted blob carries.
// `toSyncedSnapshot` is the ONLY projection: `app/lib/sync/local-store-bridge.ts`
// reads the five synced collections and hands them here rather than naming
// them a second time, so the search log's exclusion is decided in one function
// and a unit test that drives that function covers the live push path too.
// THERE IS NO INVERSE HERE, AND ITS ABSENCE IS DELIBERATE. A `withSyncedSnapshot`
// that put the synced collections back onto a full device snapshot existed with
// zero callers and was removed: an unexercised second projection is a second
// shape that has to stay correct with nothing checking that it does, which is
// exactly the defect this seam was just repaired for. The merge path writes
// through `writeMergedSnapshot`, which replaces those four tables and leaves
// the search log alone. If a full-snapshot write is ever needed, write it then,
// against a real caller and a test.
export { toSyncedSnapshot, syncedSnapshotSchema } from './blob-schema';
export type { SyncedSnapshot } from './blob-schema';

// Schema-versioned backup + the backup-nudge (last-export) tracking.
export {
  serializeBackup,
  parseBackupEnvelope,
  migrateEnvelopeForward,
  exportBackup,
  importBackup,
  restoreBackup,
  markExported,
  getLastExportAt,
  daysSinceExport,
  computeDaysSinceExport,
  hasAnyLocalData,
} from './backup';
export type { BackupEnvelope, RawBackupEnvelope } from './backup';

// Outbox: queued sync intents, flushed in strict order on reconnect.
export {
  enqueueSyncIntent,
  listOutboxRecords,
  flushOutbox,
  flushOutboxOnce,
  setOutboxRunner,
  readOutboxRecords,
  writeOutboxRecord,
} from './outbox';
export type { OutboxRunner } from './outbox';
export {
  classifyFlushOutcome,
  classifyFlushFailure,
  computeBackoffMs,
  selectFlushableRecords,
  applyFlushOutcome,
  MAX_FLUSH_ATTEMPTS,
  BASE_BACKOFF_MS,
  MAX_BACKOFF_MS,
} from './outbox-machine';
export type { FlushTransition } from './outbox-machine';
export type {
  OutboxRecord,
  OutboxIntent,
  OutboxStatus,
  EnqueueSyncInput,
  SyncAttemptResult,
  FlushOutcome,
  FlushResult,
  FlushSurface,
} from './types';

// Migration-gate device stamp. Nothing calls it today — see its module doc for
// why it is kept rather than deleted.
export {
  shouldSkipMigrationGateCheck,
  getMigrationGateClearedFor,
  setMigrationGateClearedFor,
  clearMigrationGateStamp,
} from './migration-gate';
export { shouldFallbackOffline } from './offline-fallback';

// The daily nudge's device-local day marker. A store VALUE, not an entity: it
// never enters the encrypted blob, so one device's nudge cannot silence
// another's. See `nudge.ts`.
export { localDateKey, shouldShowNudge, getNudgeShownOn, markNudgeShown } from './nudge';

// The translator's language pair, as two device-local store VALUES. Not
// entities and never synced: a phone set to Turkish must not retarget the
// laptop. See `language-pair.ts` here, and `app/lib/dictionary/language-pair.ts`
// for the shape itself and for the cookie that mirrors it to the server.
// `persistLanguagePair` is the one writer: it writes the store value AND the
// cookie mirror, so no caller can perform half of the pair of writes.
export { getLanguagePair, setLanguagePair, persistLanguagePair } from './language-pair';
