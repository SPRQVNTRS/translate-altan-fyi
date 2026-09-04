/**
 * COPIED, NOT SHARED. Source: openplate/app/lib/local-store/persist.ts @ 68e893a.
 * See .adr/0008-e2ee-sync-copied-not-extracted.md. Fixes belong upstream first,
 * then here. Do not let the two drift.
 *
 * IndexedDB persister wiring for the primary and outbox stores. The stores are
 * singletons created on first access; each is kept in sync with `startAutoLoad`
 * (loads on start, then watches for OTHER tabs' writes → this tab, every tab,
 * always) and `startLockedAutoSave` (this tab's OWN writes → IndexedDB, every
 * tab, serialized via a Web Lock scoped to each individual save — see
 * mechanism 2 below).
 *
 * These singleton getters are BROWSER-ONLY — see `assertBrowserWithIndexedDb`
 * below. Code that needs to run outside a browser (unit tests, and any future
 * server-side code) must construct a store directly (`createPrimaryStore()` /
 * `createOutboxStore()`) and pass it explicitly via the `{ store }` option
 * every local-store function accepts, rather than calling a `getXStore`
 * singleton.
 *
 * SIX SAFETY MECHANISMS live in this file, all added upstream after confirmed
 * data-loss or looping-error incidents. They are carried across verbatim
 * because they are the record of those incidents, and the reason this file is
 * shaped the way it is:
 *
 * 1. `loadAndVerifyOrThrow` — fixes a TOTAL data-loss incident where the
 *    primary store's `t` IndexedDB object store — every table — emptied to
 *    nothing while `v`, the store-level values, survived untouched; every
 *    screen then read zero rows and treated it as a brand new device. An
 *    in-memory store that comes back EMPTY after `startAutoLoad()` is only
 *    trustworthy as "this device has no data" when the persisted IndexedDB is
 *    *also* empty. If IndexedDB actually holds rows and none of them made it
 *    into the store, that is a failed or partial load, not an empty device —
 *    this function refuses to let the caller proceed to autosaving, which
 *    would otherwise overwrite the persisted rows with nothing. See its own
 *    doc for the mechanics.
 * 2. `startLockedAutoSave` / `runLockedSave` — fixes a SECOND, immediately
 *    follow-on data-loss incident introduced by an earlier version of this
 *    file's own fix for concurrent-tab clobbering: that version elected
 *    exactly ONE open tab as "the writer" (via a Web Lock held for that tab's
 *    entire lifetime) and only that tab ever called the persister's autosave.
 *    Every OTHER open tab kept reconciling reads via `startAutoLoad` but
 *    never persisted anything — so a user saving a word in a second tab
 *    would see it appear locally, then watch it silently vanish roughly a
 *    second later when that tab's own `startAutoLoad` poll replaced the
 *    store's content with whatever WAS on disk (never including that tab's
 *    unsaved write). This design makes EVERY tab able to reach disk: a Web
 *    Lock still serializes the actual write step (never two tabs' saves in
 *    flight at the same instant), but it is acquired and released around
 *    each individual `persister.save()` call, not held for a tab's whole
 *    lifetime. See `startLockedAutoSave`'s doc for the residual concurrent-
 *    write risk this does NOT (and structurally cannot, without a
 *    CRDT-merging persister) fully close.
 * 3. `installFlushOnHide` — closes a THIRD data-loss window: autosave is
 *    driven entirely by a transaction-finish listener with no flush on the
 *    page actually going away, so a user who saves a word and immediately
 *    closes the tab (or backgrounds the app) can have their write reach the
 *    in-memory store — and be told it was saved — before the async
 *    `persister.save()` chain it kicked off has actually finished writing to
 *    IndexedDB. `pagehide` and `visibilitychange`-to-`'hidden'` re-trigger the
 *    same coalescing save `startLockedAutoSave` already wires up, giving the
 *    browser the best remaining chance to let that write land before the tab
 *    is torn down. See `installFlushOnHide`'s own doc for exactly what this
 *    does and does not guarantee — IndexedDB has no synchronous write API, so
 *    this narrows the loss window, it does not close it to zero.
 * 4. `primeFreshDatabaseIfNeeded` — fixes a looping-error incident distinct
 *    from the others: `createIndexedDbPersister`'s `load()` (used by
 *    `startAutoLoad`) opens its IndexedDB database VERSIONLESS (`create=0`)
 *    and only creates the `"t"`/`"v"` object stores `save()` needs during a
 *    version-2 upgrade it runs itself (`create=1`) — see this library's
 *    source, `persisters/persister-indexed-db/index.js`'s `forObjectStores`.
 *    On a device where a given store has never saved anything (the mechanism
 *    is generic to every `getXStore()` singleton below, since they all share
 *    this one `initPersistedStore`), the versionless load-open creates an
 *    EMPTY v1 database with NO object stores at all; the very next
 *    `transaction(['t','v'])` throws `NotFoundError`, and `startAutoLoad`'s
 *    ~1s poll repeats that failure forever — this is what a device would
 *    otherwise self-heal from only the moment SOMETHING first saves.
 *    `primeFreshDatabaseIfNeeded` runs a one-time, empty `persister.save()`
 *    before `startAutoLoad` ever gets a chance to poll, which is enough to
 *    trigger the v2 upgrade and create both object stores up front. An empty
 *    save can never clobber data — see `shouldPrimePersistedDb`'s doc for why
 *    `readPersistedTableRowCounts` resolving `null` proves there was nothing
 *    to clobber.
 * 5. `recordChangesDuringLoad` (inside `startLockedAutoSave`) + `saveOnceLoadFinished`
 *    (inside `runLockedSave`) — closes a FOURTH window. Unlike the three
 *    above this one was not reported by a user: it surfaced while fixing an
 *    intermittent test failure, and was then reproduced deterministically
 *    against real `tinybase`. TWO of its behaviours conspire whenever a
 *    local write lands while THIS SAME persister's `startAutoLoad` poll has a
 *    load in flight — a window a few milliseconds wide, once per poll:
 *
 *      a. `persister.save()` is a SILENT no-op while that persister is
 *         Loading. `createCustomPersister`'s `save` body is wrapped in
 *         `if (status != Loading)`, with no queue, no retry, no thrown error
 *         and no falsy return — it just resolves, having persisted nothing.
 *         `startAutoSave`'s own listener calls `save()` fire-and-forget, so a
 *         dropped save is never retried either.
 *      b. That same poll finishes by calling `store.setContent(diskContent)`
 *         — a FULL-CONTENT replace, not a merge. So the write is not merely
 *         left unsaved: it is erased from the in-memory store too, and hence
 *         from the UI.
 *
 *    (b) is what makes this data loss rather than a missed save. Because the
 *    row is gone from memory before any later save can run, "a dropped save
 *    is recovered by the next successful save" is FALSE here — the next save
 *    faithfully persists a store that no longer contains the write. Fixing
 *    (a) alone would therefore have changed nothing a user could see.
 *
 *    The fix is in two halves. `startLockedAutoSave` records every local
 *    transaction that finishes while a load is in flight and, the moment that
 *    load ends, re-applies the ones the load's full-content replace threw
 *    away (see `clobberedByLoad` for how the load's OWN replace is told apart
 *    from the user's writes). `runLockedSave` waits out any in-flight load
 *    before calling `save()`, so the save that persists that restoration —
 *    and, just as importantly, a `pagehide` flush that happens to land during
 *    a poll — is not itself silently discarded by (a). See
 *    `startLockedAutoSave`'s doc for the windows this still does NOT close.
 * 6. `pendingSinceSave` (inside `startLockedAutoSave`) — closes the INVERSE of
 *    (5), which (5) deliberately left open and which then produced a real
 *    user-visible defect: a saved word showed its success toast and was simply
 *    gone, in memory and on disk, immediately afterwards (openplate#1).
 *
 *    (5) only protects a write that finishes while a load is ALREADY in
 *    flight, because that is the only window it records anything for. A write
 *    that finishes with NO load in flight is recorded nowhere — and its save
 *    is not instantaneous: it has to acquire the cross-tab Web Lock, a hop
 *    that in practice lasts as long as the main thread is busy (after a save,
 *    that is a whole route navigation and re-render). A poll that starts
 *    inside that hop erases the write with its full-content replace, the
 *    load-end handler sees a window containing only the replace and restores
 *    nothing, and the save it was waiting for then faithfully persists a store
 *    that no longer contains the write.
 *
 *    The fix is to stop keying the undo log on "was a load in flight?" — an
 *    accident of timing — and key it on the thing that actually matters:
 *    whether the write is PROVEN to be on disk. Every local transaction is
 *    kept in `pendingSinceSave` until a `save()` that started no earlier than
 *    it has resolved, and every load end re-applies whatever is still pending.
 *    Re-applying costs nothing when nothing was clobbered (TinyBase reports an
 *    untouched transaction — see `reapplyRecordedTransactions`), so this is a
 *    widening of (5)'s window, not a second mechanism competing with it.
 */
import { createIndexedDbPersister } from 'tinybase/persisters/persister-indexed-db';
import type { ChangedCells, ChangedValues, Store } from 'tinybase';
import { z } from 'zod';
import type { JsonValue } from '#app/lib/json';
import { createOutboxStore, createPrimaryStore, OUTBOX_DB_NAME, PRIMARY_DB_NAME } from './store';

/**
 * The logging seam, and a DELIBERATE DIVERGENCE from the source. Upstream this
 * module logs through `#app/lib/logger`, which in this repo is pino reading
 * `process.env` at module load — a server dependency, and this file is imported
 * by the browser bundle. The call sites, their levels and their fields are
 * otherwise unchanged, because they are the diagnosis path for every incident
 * in the module doc above: a future occurrence has to be readable from a
 * console the same way it was readable from log aggregation.
 *
 * Row COUNTS are logged, never row CONTENTS — a list name, a saved word and a
 * search query are all things this app exists not to disclose.
 */
const log = {
  info(message: string, context: JsonValue): void {
    console.info(message, context);
  },
  warn(message: string, context: JsonValue): void {
    console.warn(message, context);
  },
  error(message: string, context: JsonValue): void {
    console.error(message, context);
  },
};

/** One row of the persister's `tables` object store: `k` is the table name, `v` that table's rows. */
const persistedTableRowSchema = z.looseObject({ k: z.string() });

/** A table's rows as the persister stores them — keyed by row id; anything else counts as zero rows. */
const persistedTableRowsSchema = z.looseObject({});

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/** Stand-in unsubscribe for a mechanism that had nothing to subscribe to. */
function noop(): void {}

function isBrowserWithIndexedDb(): boolean {
  return globalThis.window !== undefined && globalThis.indexedDB !== undefined;
}

/**
 * Guards every `getXStore()` singleton against ever being resolved outside a
 * browser. Before this guard, `initPersistedStore` silently fell back to an
 * UNPERSISTED, in-memory store whenever `indexedDB` was undefined (SSR, a
 * Node process, an unsupported browser) — which, on a server, means every
 * request sharing this module's process-wide singleton would share ONE
 * in-memory store across every user. Loud failure here is strictly better than
 * that silent cross-user data leak. Only the singleton getters call this —
 * the pure CRUD functions (`primary-store.ts`, `backup.ts`, ...) never call it
 * directly; they only reach it indirectly, and only when the caller omitted an
 * explicit `{ store }` override.
 */
function assertBrowserWithIndexedDb(dbName: string): void {
  if (isBrowserWithIndexedDb()) return;
  throw new Error(
    `local-store is browser-only: getXStore("${dbName}") was called outside a browser with IndexedDB support. ` +
      'Never call a getXStore() singleton from server-side code. In tests, construct a store directly ' +
      '(createPrimaryStore()/createOutboxStore()) and pass an explicit { store } option instead.',
  );
}

/**
 * Asks the browser to make this origin's storage persistent (eviction-resistant)
 * so the primary data survives storage pressure. Requested lazily from the
 * primary-store WRITE path (see `primary-store.ts`) on the first write — NOT
 * gated on PWA install, so a user who never installs still gets the durability
 * request the moment they save anything. Fire-and-forget and single-shot: the
 * browser only prompts (if at all) once per origin, and an already-persisted
 * origin resolves `true` immediately. Inert under SSR/Node (no `navigator`).
 */
let persistRequested = false;
export function requestPersistentStorage(): void {
  if (persistRequested) return;
  persistRequested = true;
  if (globalThis.navigator === undefined || !navigator.storage?.persist) return;
  void navigator.storage.persist().catch(() => {
    // A rejected/denied persistence request is non-fatal — the data still lives
    // in IndexedDB, just without the eviction-resistance guarantee. The backup
    // nudge (backup.ts) is the durable fallback for that case.
  });
}

// ---------------------------------------------------------------------------
// Mechanism 1: never let an empty in-memory store overwrite a non-empty
// persisted store (the anti-clobber load-verification invariant).
// ---------------------------------------------------------------------------

/**
 * The object store name `tinybase/persisters/persister-indexed-db` uses to hold
 * table content — one row per table, `{k: tableId, v: tableContent}`. This is
 * an implementation detail of the library, not a published API, but it's the
 * only way to read "does IndexedDB actually have data" without going through
 * the very `Store`/`Persister` load path this module exists to verify.
 */
const PERSISTER_TABLES_OBJECT_STORE = 't';

/**
 * Independently inspects the raw IndexedDB database at `dbName`, bypassing
 * the TinyBase `Store`/`Persister` abstraction entirely, to determine how
 * many rows each table currently holds ON DISK. This is the ground truth
 * {@link loadAndVerifyOrThrow} cross-checks the in-memory store against once
 * `startAutoLoad()` resolves — the persister's own return value can't tell us
 * whether a load actually populated anything, or just quietly found nothing
 * to load (both look identical from the `Store`'s perspective).
 *
 * Resolves `null` when the database (or its `"t"` object store) doesn't exist
 * yet — a genuinely fresh device, nothing has ever been persisted. Resolves a
 * `{ [tableId]: rowCount }` map otherwise (an empty object when the object
 * store exists but every table in it is empty).
 *
 * This probe never CREATES a database as a side effect. A versionless
 * `indexedDB.open(dbName)` only reaches `onupgradeneeded` when `dbName`
 * doesn't exist on disk at all — implicitly requesting version 1 against a
 * database at version 0 — and letting that implicit upgrade transaction
 * commit (as an earlier version of this function did, with a no-op
 * `onupgradeneeded`) leaves behind a real, empty v1 database purely as an
 * artifact of what is meant to be a read-only probe. Aborting the upgrade
 * transaction instead rolls the version change back entirely, so nothing is
 * created; per the IndexedDB spec that abort surfaces as the open request's
 * `onerror`, which this function treats as the same "fresh device" outcome
 * `onsuccess`'s missing-object-store branch already resolves to.
 */
export async function readPersistedTableRowCounts(dbName: string): Promise<Record<string, number> | null> {
  return new Promise((resolve, reject) => {
    let isFreshDeviceProbe = false;
    const request = indexedDB.open(dbName);
    request.onupgradeneeded = () => {
      // Reaching here means `dbName` doesn't exist yet at all — see the doc
      // above. Abort rather than let the implicit v1 upgrade commit, so this
      // read-only probe never materializes a database as a side effect; the
      // abort is what turns into `onerror` below.
      isFreshDeviceProbe = true;
      request.transaction?.abort();
    };
    // Not expected to actually fire from the abort above (there is nothing
    // else that could be blocking a version change on a database that
    // doesn't exist yet), but handled the same way defensively — a blocked
    // open is exactly as inconclusive as "doesn't exist yet" for this probe's
    // purposes.
    request.onblocked = () => {
      resolve(null);
    };
    request.addEventListener('error', () => {
      if (isFreshDeviceProbe) {
        resolve(null);
        return;
      }
      reject(new Error(`readPersistedTableRowCounts("${dbName}"): indexedDB.open failed`));
    });
    request.onsuccess = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(PERSISTER_TABLES_OBJECT_STORE)) {
        db.close();
        resolve(null);
        return;
      }
      const getAllRequest = db
        .transaction(PERSISTER_TABLES_OBJECT_STORE, 'readonly')
        .objectStore(PERSISTER_TABLES_OBJECT_STORE)
        .getAll();
      getAllRequest.addEventListener('success', () => {
        const counts: Record<string, number> = {};
        for (const raw of getAllRequest.result) {
          const row = persistedTableRowSchema.safeParse(raw);
          if (!row.success) continue;
          const tableRows = persistedTableRowsSchema.safeParse(row.data.v);
          counts[row.data.k] = tableRows.success ? Object.keys(tableRows.data).length : 0;
        }
        db.close();
        resolve(counts);
      });
      getAllRequest.addEventListener('error', () => {
        db.close();
        reject(
          new Error(
            `readPersistedTableRowCounts("${dbName}"): "${PERSISTER_TABLES_OBJECT_STORE}" object store read failed`,
          ),
        );
      });
    };
  });
}

/** Sums a table→rowCount map from {@link readPersistedTableRowCounts}; `null` (no persisted DB yet) sums to 0. */
export function totalRowCount(counts: Record<string, number> | null): number {
  if (!counts) return 0;
  return Object.values(counts).reduce((sum, count) => sum + count, 0);
}

/**
 * Whether a fresh, one-time "priming" save is needed before this store's
 * first `startAutoLoad()` poll — see mechanism 4 in this file's module doc
 * for the looping-error incident this closes. `counts === null` is exactly
 * {@link readPersistedTableRowCounts}'s "genuinely fresh device" outcome: no
 * database, or a database with no `"t"` object store, has ever been
 * persisted for this `dbName`. Priming is safe to skip once counts is a real
 * (possibly empty) map — the object stores already exist in that case, so
 * `startAutoLoad`'s `load()` won't hit the `NotFoundError` this predicate
 * exists to prevent.
 */
export function shouldPrimePersistedDb(counts: Record<string, number> | null): boolean {
  return counts === null;
}

/** Per-table row counts for the in-memory store — the counterpart to {@link readPersistedTableRowCounts}, for telemetry and the empty-store check below. */
export function storeRowCounts(store: Store): Record<string, number> {
  return Object.fromEntries(
    Object.entries(store.getTables()).map(([tableId, rows]) => [tableId, Object.keys(rows).length]),
  );
}

/** Whether the in-memory store currently holds zero rows across every table. */
export function isStoreEmpty(store: Store): boolean {
  return Object.values(store.getTables()).every((rows) => Object.keys(rows).length === 0);
}

/**
 * The core invariant, pure: an in-memory store that comes back EMPTY after a
 * load must never be trusted to autosave over a persisted IndexedDB that
 * actually had rows. `persistedRowCount === 0` covers BOTH the legitimate
 * "brand new device" case and "a persisted DB exists but is genuinely empty"
 * — neither is a failure, so autosave proceeds normally in either. Only "the
 * disk had rows, and none of them made it into memory" refuses — that
 * combination has no honest explanation other than a failed or partial load.
 */
export function shouldRefuseAutosave({
  persistedRowCount,
  storeIsEmptyAfterLoad,
}: {
  persistedRowCount: number;
  storeIsEmptyAfterLoad: boolean;
}): boolean {
  return persistedRowCount > 0 && storeIsEmptyAfterLoad;
}

/**
 * The narrow slice of `IndexedDbPersister` {@link loadAndVerifyOrThrow} needs.
 * Deliberately NOT `Pick<IndexedDbPersister, 'startAutoLoad'>` — the real
 * persister's `startAutoLoad` resolves `Promise<this>`, which a lightweight
 * test double (simulating a "broken load" persister) has no reason to
 * replicate; widening the return type to `Promise<LoadStep | void>` keeps a
 * real `IndexedDbPersister` assignable here while letting tests pass a plain
 * `{ startAutoLoad: async () => {} }`.
 */
interface LoadStep {
  startAutoLoad: () => Promise<LoadStep | void>;
}

/**
 * Runs `persister.startAutoLoad()` and enforces the anti-clobber invariant
 * BEFORE the caller is allowed to proceed to autosaving: if IndexedDB
 * held rows and none of them made it into the in-memory store, this throws
 * instead of letting the caller start autosaving — which would otherwise
 * overwrite the persisted data with nothing. This is exactly the mechanism
 * behind the confirmed data-loss incident: `startAutoLoad()` resolving
 * without having actually populated the store (empty/partial/failed load),
 * immediately followed by an unconditional autosave.
 *
 * Row COUNTS (never row CONTENTS — no list names, no saved words, no search
 * queries) are logged on every call, success or refusal, so a future
 * occurrence is diagnosable even though the failure itself happens entirely
 * client-side.
 */
export async function loadAndVerifyOrThrow(store: Store, dbName: string, persister: LoadStep): Promise<void> {
  let persistedCountsBeforeLoad: Record<string, number> | null;
  try {
    persistedCountsBeforeLoad = await readPersistedTableRowCounts(dbName);
  } catch (error) {
    log.error('local-store: failed to independently verify persisted IndexedDB contents before load', {
      dbName,
      error: errorMessage(error),
    });
    throw error;
  }
  const persistedRowCount = totalRowCount(persistedCountsBeforeLoad);

  await persister.startAutoLoad();

  const storeIsEmptyAfterLoad = isStoreEmpty(store);
  log.info('local-store load complete', {
    dbName,
    persistedRowCount,
    persistedTableCountsBeforeLoad: persistedCountsBeforeLoad,
    inMemoryTableCountsAfterLoad: storeRowCounts(store),
  });

  if (!shouldRefuseAutosave({ persistedRowCount, storeIsEmptyAfterLoad })) return;

  log.error(
    'local-store REFUSED to start autosave: IndexedDB holds data but the in-memory store is empty after startAutoLoad. ' +
      'Starting autosave now would overwrite the persisted data with nothing, so this is refused instead.',
    { dbName, persistedRowCount, persistedTableCountsBeforeLoad: persistedCountsBeforeLoad },
  );
  throw new Error(
    `local-store "${dbName}": persisted IndexedDB has ${persistedRowCount} row(s) but the in-memory store is empty ` +
      'after load. Refusing to start autosave to avoid overwriting persisted data with an empty store.',
  );
}

// ---------------------------------------------------------------------------
// Mechanism 2: lock-scoped saves (Web Locks API) — EVERY tab persists its own
// writes; the lock only serializes the disk WRITE step itself, never longer.
// ---------------------------------------------------------------------------

/**
 * The Web Lock name prefix for a save. DELIBERATELY DISTINCT from the sync
 * orchestrator's own lock name: the two are acquired in a fixed order (sync
 * outside, save inside), and sharing one name would turn that ordering into a
 * self-deadlock the first time a sync cycle saved.
 */
const SAVE_LOCK_PREFIX = 'translate-local-store-save:';

/** Injectable seam for tests — see `runLockedSave`'s `requestLock` option. */
type LockRequester = (lockName: string, run: () => Promise<void>) => void;

function requestLockViaWebLocksApi(lockName: string, run: () => Promise<void>): void {
  void navigator.locks.request(lockName, run);
}

function hasWebLocksApi(): boolean {
  return globalThis.navigator !== undefined && navigator.locks?.request !== undefined;
}

/**
 * TinyBase's `Status.Loading`, spelled as a local constant rather than
 * imported: `Status` is a `const enum`, which does not survive this repo's
 * transpile-only test runner (`node --import tsx --test`). 0 = Idle,
 * 1 = Loading, 2 = Saving — verified against `tinybase`'s `persisters/index.js`.
 */
const PERSISTER_STATUS_LOADING = 1;

/**
 * The narrow slice of `IndexedDbPersister` {@link runLockedSave} needs — see
 * {@link LoadStep}'s doc for why this isn't `Pick<IndexedDbPersister, 'save'>`
 * directly (the real `save(): Promise<this>` return type doesn't structurally
 * match a `Promise<void>`-returning test double).
 *
 * The three status members are OPTIONAL on purpose. A real
 * `IndexedDbPersister` always has them, so production always gets mechanism 5
 * (see this file's module doc); a lightweight `{ save }` test double that only
 * cares about the locking behavior does not have to grow three more members it
 * would never exercise. {@link createPersisterLoadGate} returns `null` for such
 * a double, and every mechanism-5 code path is then inert rather than guessing.
 */
interface SaveStep {
  save: () => Promise<SaveStep | void>;
  /** `Status` as a plain number — see {@link PERSISTER_STATUS_LOADING}. */
  getStatus?(): number;
  addStatusListener?(listener: (persister: SaveStep, status: number) => void): string;
  delListener?(listenerId: string): void;
}

/**
 * The persister-load seam mechanisms 5 and 6 both need, reduced to the two
 * questions they actually ask: "is a load in flight right now?" and "tell me
 * when that changes". Narrowing to this (rather than passing whole persisters
 * around) is what lets both mechanisms be driven from a hand-rolled double in
 * tests — a real load is otherwise a few unobservable milliseconds long.
 */
export interface LoadGate {
  /**
   * Whether the persister is in TinyBase's `Loading` status AT THIS INSTANT.
   * Callers must treat this as valid only for the current synchronous turn:
   * it is exactly the flag `persister.save()` itself reads, so a check
   * followed — with no `await` in between — by `save()` is an exact predictor
   * of whether that save will be silently discarded. Put an `await` between
   * them and it becomes a guess.
   */
  isLoading: () => boolean;
  /** Subscribes to load start/end transitions. Returns an unsubscribe function. */
  onLoadStateChange: (listener: (isLoading: boolean) => void) => () => void;
}

function isStatusAwarePersister(
  persister: SaveStep,
): persister is SaveStep & Required<Pick<SaveStep, 'getStatus' | 'addStatusListener' | 'delListener'>> {
  return (
    persister.getStatus !== undefined && persister.addStatusListener !== undefined && persister.delListener !== undefined
  );
}

/**
 * Adapts a real TinyBase persister's status API to {@link LoadGate}, or
 * returns `null` for a `{ save }`-only double that cannot report its status
 * (in which case both mechanism-5 code paths no-op — see {@link SaveStep}).
 */
export function createPersisterLoadGate(persister: SaveStep): LoadGate | null {
  if (!isStatusAwarePersister(persister)) return null;
  return {
    isLoading: () => persister.getStatus() === PERSISTER_STATUS_LOADING,
    onLoadStateChange: (listener) => {
      const listenerId = persister.addStatusListener((_persister, status) => {
        listener(status === PERSISTER_STATUS_LOADING);
      });
      return () => {
        persister.delListener(listenerId);
      };
    },
  };
}

/**
 * Upper bound on how long {@link waitForLoadToFinish} will wait for an
 * in-flight load before giving up and saving anyway. This is a SAFETY NET, not
 * a normal path: the thing being waited for is a single IndexedDB read, which
 * finishes in single-digit milliseconds on any healthy device. The bound
 * exists only so that a load which never settles (a wedged IndexedDB, a
 * persister destroyed mid-flight) can never leave a save promise pending
 * forever — and, through `startLockedAutoSave`'s `saveInFlight` flag, this
 * tab's autosave permanently stuck.
 */
const LOAD_WAIT_TIMEOUT_MS = 2_000;

/**
 * Resolves once no load is in flight on `gate`, so the caller can issue a
 * `persister.save()` that TinyBase will not silently discard (see this file's
 * module doc, mechanism 5a). Returns immediately — no `await`, same
 * synchronous turn — when nothing is loading, which is the overwhelmingly
 * common case.
 *
 * ON THE `pagehide` PATH specifically (`installFlushOnHide` → `triggerSave` →
 * `runLockedSave` → here): waiting is strictly better than not waiting, even
 * though the page may be torn down at any moment. The alternative is not "save
 * now" — it is TinyBase silently discarding the save, which is what the
 * unfixed code did. So the worst case of waiting is that the page dies during
 * the wait and nothing is persisted, exactly matching the unfixed behavior;
 * the normal case is that the load finishes within a few milliseconds and the
 * flush actually lands. The wait is never unbounded, so this can never hold
 * the teardown open indefinitely either.
 *
 * @returns `true` when the wait ended because the load finished, `false` when the bound expired first.
 */
async function waitForLoadToFinish(gate: LoadGate, timeoutMs: number): Promise<boolean> {
  if (!gate.isLoading()) return true;

  let unsubscribe: (() => void) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await new Promise<boolean>((resolve) => {
      unsubscribe = gate.onLoadStateChange((isLoading) => {
        if (isLoading) return;
        resolve(true);
      });
      timer = setTimeout(() => resolve(false), timeoutMs);
    });
  } finally {
    unsubscribe?.();
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Runs `persister.save()` for at most one tab at a time against a given
 * `dbName`, using the Web Locks API as a mutex scoped to THIS ONE save call —
 * acquired immediately before it, released immediately after. This replaces
 * an earlier `becomeAutoSaveWriter`, which held its lock for an elected tab's
 * ENTIRE lifetime and only ever called save from that one tab — see this
 * file's module doc for the data-loss incident that caused.
 *
 * The save itself is wrapped so that it is never issued while the SAME
 * persister has a load in flight, which TinyBase would silently discard (see
 * this file's module doc, mechanism 5a). That wait deliberately happens INSIDE
 * the lock callback: the status check and the `save()` call then sit in one
 * synchronous turn with no lock round-trip between them, which is the only
 * arrangement in which the check is an exact predictor rather than a guess.
 * The cost is holding the cross-tab lock for the few milliseconds a load takes
 * — cheap next to silently persisting nothing.
 *
 * Falls back to an unmutexed `persister.save()` (still saves — just without
 * the lock's ordering guarantee) on browsers without the Web Locks API. Rare
 * — Safari shipped it in 15.4 — but never refuse to persist over it.
 *
 * `requestLock`/`hasLocks`/`loadGate`/`loadWaitTimeoutMs` are injectable so
 * both behaviors — at most one save in flight at a time with a queued save
 * still eventually running, and a save deferred until a load finishes — are
 * directly unit-testable without a real browser or two real tabs.
 */
export async function runLockedSave(
  dbName: string,
  persister: SaveStep,
  {
    requestLock = requestLockViaWebLocksApi,
    hasLocks = hasWebLocksApi(),
    loadGate = createPersisterLoadGate(persister),
    loadWaitTimeoutMs = LOAD_WAIT_TIMEOUT_MS,
  }: {
    requestLock?: LockRequester;
    hasLocks?: boolean;
    loadGate?: LoadGate | null;
    loadWaitTimeoutMs?: number;
  } = {},
): Promise<void> {
  async function saveOnceLoadFinished(): Promise<void> {
    if (loadGate) {
      const loadFinished = await waitForLoadToFinish(loadGate, loadWaitTimeoutMs);
      if (!loadFinished) {
        log.warn(
          'local-store: a persister load was still in flight after the save wait bound expired — saving anyway. ' +
            'TinyBase discards a save issued while the same persister is loading, so this one may not reach IndexedDB.',
          { dbName, loadWaitTimeoutMs },
        );
      }
    }
    await persister.save();
  }

  if (!hasLocks) {
    await saveOnceLoadFinished();
    return;
  }

  await new Promise<void>((resolve, reject) => {
    requestLock(`${SAVE_LOCK_PREFIX}${dbName}`, async () => {
      try {
        await saveOnceLoadFinished();
        resolve();
      } catch (error) {
        reject(error instanceof Error ? error : new Error(errorMessage(error)));
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Mechanism 5: keep a local write that lands during an autoLoad poll from
// being erased by that poll's full-content replace.
// ---------------------------------------------------------------------------

/**
 * One finished store transaction, kept only long enough to put it back if the
 * concurrent load throws it away. Holds the `changedCells`/`changedValues`
 * halves of `store.getTransactionLog()` verbatim — TinyBase builds a fresh
 * object per transaction, so keeping the reference costs nothing and copies
 * nothing.
 */
export interface RecordedTransaction {
  changedCells: ChangedCells;
  changedValues: ChangedValues;
}

/**
 * Re-applies the NEW half of each recorded transaction, in the order they
 * originally happened, as a single store transaction (so the whole
 * restoration triggers exactly one autosave rather than one per entry).
 *
 * Idempotent by construction: re-applying a change whose value is already
 * present writes the same value again, which TinyBase reports as an untouched
 * transaction. That matters because this runs unconditionally after a load —
 * it must be free when nothing was actually clobbered.
 *
 * A cell or value whose recorded NEW half is `undefined` was DELETED by the
 * original transaction, and is re-deleted here. Skipping deletions would be
 * the easy way to avoid ever resurrecting a row, but it would also mean a list
 * item the user deleted could reappear after the next poll — a worse bug than
 * the one this closes.
 */
export function reapplyRecordedTransactions(store: Store, recorded: readonly RecordedTransaction[]): void {
  store.transaction(() => {
    for (const { changedCells, changedValues } of recorded) {
      for (const [tableId, rows] of Object.entries(changedCells)) {
        for (const [rowId, cells] of Object.entries(rows)) {
          for (const [cellId, [, newCell]] of Object.entries(cells)) {
            if (newCell === undefined) store.delCell(tableId, rowId, cellId, true);
            else store.setCell(tableId, rowId, cellId, newCell);
          }
        }
      }
      for (const [valueId, [, newValue]] of Object.entries(changedValues)) {
        if (newValue === undefined) store.delValue(valueId);
        else store.setValue(valueId, newValue);
      }
    }
  });
}

/**
 * Of the transactions that finished while a load was in flight, the ones the
 * load's own full-content replace clobbered — i.e. everything except the
 * replace itself.
 *
 * TinyBase gives no flag distinguishing "the persister just called
 * `store.setContent(diskContent)`" from "the user just wrote a row", so this
 * uses POSITION instead: within one load window the replace is always the LAST
 * recorded transaction. That follows from `createCustomPersister`'s `load`,
 * where `setContentOrChanges(content)` and the `setStatus(Idle)` that closes
 * the window are adjacent synchronous statements with no `await` between them,
 * so nothing else can be recorded after it. Verified empirically against a
 * real `tinybase`, not just read off the source.
 *
 * The two ways that reasoning could be wrong are both harmless, which is why
 * this is a plain `slice` rather than something cleverer:
 *  - The load failed before reaching `setContentOrChanges` (a rejected
 *    IndexedDB read — including the benign `NotFoundError` on a brand-new
 *    device's first-ever load, see `initPersistedStore`'s `onIgnoredError`
 *    note). Then the last entry is a genuine local write and gets dropped from
 *    the restoration — but no replace happened, so nothing was clobbered and
 *    the restoration was not needed.
 *  - The replace changed nothing, so TinyBase reported an untouched
 *    transaction and it was never recorded at all. That can only happen when
 *    no local write was recorded either: a local write during the window is by
 *    definition not on disk, so the replace that follows it necessarily
 *    removes it and is necessarily a change.
 */
export function clobberedByLoad(recordedDuringLoad: readonly RecordedTransaction[]): RecordedTransaction[] {
  return recordedDuringLoad.slice(0, -1);
}

/**
 * Installs a listener that persists THIS tab's own writes to IndexedDB via
 * {@link runLockedSave}, for as long as `store` exists — every open tab gets
 * one (see `runLockedSave`'s doc for why this replaced the old
 * single-elected-writer design, and this file's module doc for the incident
 * that caused). Fires on every locally-finished transaction that actually
 * touched cells or values (per `store.getTransactionLog()`) — including
 * transactions caused by `startAutoLoad` reconciling ANOTHER tab's write into
 * this one, which triggers a redundant-but-harmless echo save (this tab
 * writing back exactly what it just read). That's accepted rather than
 * specially filtered out: distinguishing "changed by a local write" from
 * "changed by incoming reconciliation" isn't exposed by the Store API at this
 * listener, and the echo save is idempotent when nothing else has changed in
 * between.
 *
 * Saves that arrive while one is already in flight are coalesced into a
 * single follow-up save rather than queuing one lock request per transaction
 * — a burst of several local writes (e.g. saving three words back to back)
 * results in at most two `persister.save()` calls: the one already running,
 * plus one more covering everything that changed since it started.
 *
 * RESIDUAL RISK — deliberately NOT solved here. `readPersistedTableRowCounts`'s
 * doc above covers the on-disk format: this is a plain, non-Mergeable `Store`
 * whose persister replaces a table's ENTIRE content on every save, not a
 * per-row merge. The lock guarantees no two tabs' `save()` calls are EVER in
 * flight at the same instant, but it does NOT make two tabs' writes to the
 * SAME table merge. If tab A and tab B each add a different row to the same
 * table within the ~1s `startAutoLoad` reconciliation window — before either
 * has picked up the other's write — whichever tab's save runs last overwrites
 * that whole table with its own (still-unaware-of-the-other) view, discarding
 * the other's row from disk. The losing tab's OWN in-memory copy is
 * untouched, so if it makes another local write afterward, that later save
 * carries the "lost" row back to disk; if it never writes again, the row
 * stays lost from disk (though still visible in that tab's own UI) until that
 * tab closes or reloads. Fully closing this needs a CRDT-merging persister
 * (TinyBase's `MergeableStore` + a `Mergeable`-aware persister) — a real
 * capability, but a materially bigger change than this fix's scope. Every tab
 * still reconciles every other tab's SUCCESSFULLY persisted writes via
 * `startAutoLoad`'s polling regardless of any of this.
 *
 * The inverse of mechanism 5's window — a write that finishes with NO load in
 * flight, whose save is then overtaken by a poll starting during the hop it
 * takes to acquire the save lock — used to be left open here, and was the
 * cause of openplate#1 (a saved entry vanishing behind its own success toast).
 * It is closed by mechanism 6: `pendingSinceSave` below keeps every local
 * transaction re-appliable until a save has provably carried it to disk, and
 * every load end re-applies what is still pending, regardless of when the
 * write happened.
 *
 * @returns An unsubscribe function that stops this tab from autosaving.
 */
export function startLockedAutoSave(
  store: Store,
  dbName: string,
  persister: SaveStep,
  {
    requestLock = requestLockViaWebLocksApi,
    hasLocks = hasWebLocksApi(),
    flushOnHideDeps = defaultFlushOnHideDeps(),
    loadGate = createPersisterLoadGate(persister),
    loadWaitTimeoutMs = LOAD_WAIT_TIMEOUT_MS,
  }: {
    requestLock?: LockRequester;
    hasLocks?: boolean;
    flushOnHideDeps?: FlushOnHideDeps | null;
    loadGate?: LoadGate | null;
    loadWaitTimeoutMs?: number;
  } = {},
): () => Promise<void> {
  if (!hasLocks) {
    log.warn('local-store: Web Locks API unavailable — falling back to unmutexed autosave for this tab', { dbName });
  }

  let saveInFlight = false;
  let saveAgainRequested = false;

  // Mechanism 6 (see this file's module doc). Every local transaction that is
  // not yet PROVEN to be on disk, oldest first — the undo log a load's
  // full-content replace is measured against. An entry leaves only when a
  // `persister.save()` that started no earlier than the entry itself has
  // resolved; until then the write is re-appliable, which is what makes the
  // restoration below independent of whether a load happened to be in flight
  // at the instant the write finished.
  let pendingSinceSave: RecordedTransaction[] = [];

  /**
   * One save, plus the bookkeeping that lets its writes stop being pending.
   *
   * The snapshot is taken BEFORE the save rather than after, deliberately:
   * `persister.save()` serializes the store as it stands when it actually
   * runs, which is never earlier than this line, so every snapshotted entry is
   * necessarily included in what reached disk. Entries that land during the
   * save stay pending and are covered by the next one — conservative in the
   * only direction that is safe.
   *
   * On a throw nothing is cleared: a failed save proves nothing, and the
   * writes must stay re-appliable.
   */
  async function runSaveCoveringPending(): Promise<void> {
    const covered = new Set(pendingSinceSave);
    await runLockedSave(dbName, persister, { requestLock, hasLocks, loadGate, loadWaitTimeoutMs });
    pendingSinceSave = pendingSinceSave.filter((recorded) => !covered.has(recorded));
  }

  /**
   * The save loop that is running right now, or an already-settled promise.
   *
   * IT EXISTS SO THE TEARDOWN CAN WAIT. Destroying a TinyBase persister while
   * one of its own scheduled actions is mid-flight tears the action schedule
   * out from under that action: `destroy()` filters and clears the schedule,
   * and the running action's own `finally` then splices an array the destroy
   * has already emptied. That surfaced in a browser walk on 2026-09-04 as
   * `locked autosave failed ... Cannot read properties of undefined (reading
   * 'splice')` at the instant of sign-out, and it left the delete that came
   * after it unfinished. So the teardown drains before anything is destroyed.
   */
  let drain: Promise<void> = Promise.resolve();

  /**
   * Runs the coalescing save loop until nothing more is pending.
   *
   * `saveAgainRequested` is drained INSIDE this loop rather than by a second
   * call, which is what makes awaiting {@link drain} enough: a write that
   * lands while a save is in flight is covered by the same promise.
   */
  async function runSaveLoop(): Promise<void> {
    try {
      await runSaveCoveringPending();
      while (saveAgainRequested) {
        saveAgainRequested = false;
        await runSaveCoveringPending();
      }
    } catch (error) {
      log.error('local-store: locked autosave failed', { dbName, error: errorMessage(error) });
    } finally {
      saveInFlight = false;
    }
  }

  function triggerSave(): Promise<void> {
    if (saveInFlight) {
      saveAgainRequested = true;
      // The caller is told to wait for the loop that is ALREADY running, not
      // handed a resolved promise. A drain that returned early here would let
      // a destroy start on top of a live save, which is the whole defect.
      return drain;
    }
    saveInFlight = true;
    drain = runSaveLoop();
    return drain;
  }

  // Mechanism 5 (see this file's module doc). Non-null exactly while a load is
  // in flight, holding every transaction that finished during it — the user's
  // writes, which that load's full-content replace is about to erase, plus the
  // replace itself. `clobberedByLoad` separates the two.
  let recordedDuringLoad: RecordedTransaction[] | null = null;

  /** True only for the synchronous span of a pending-write restoration, so the transaction listener can report a restoration that actually changed something. */
  let restoringPending = false;

  const stopWatchingLoads =
    loadGate?.onLoadStateChange((isLoading) => {
      if (isLoading) {
        recordedDuringLoad = [];
        return;
      }
      const recorded = recordedDuringLoad;
      recordedDuringLoad = null;
      if (!recorded) return;

      // The load's OWN full-content replace is the one transaction in that
      // window that must never be re-applied — it IS the erase. `clobberedByLoad`
      // says which of the window's entries were local writes (everything but
      // the last); whatever is left over is the replace, and it is dropped from
      // the pending log rather than restored.
      const localWrites = clobberedByLoad(recorded);
      for (const loadsOwnReplace of recorded.slice(localWrites.length)) {
        pendingSinceSave = pendingSinceSave.filter((entry) => entry !== loadsOwnReplace);
      }
      if (pendingSinceSave.length === 0) return;

      // Synchronous on purpose: this runs from the status listener that fires
      // the instant the load ends, so the store is repaired before anything
      // else — including the save waiting on that same transition inside
      // `runLockedSave` — gets to observe the clobbered state. The restoration
      // is itself a store transaction, so the listener below picks it up and
      // persists it through the normal path — and reports it, since a
      // restoration that changed nothing produces no transaction at all.
      restoringPending = true;
      try {
        reapplyRecordedTransactions(store, pendingSinceSave);
      } finally {
        restoringPending = false;
      }
    }) ?? noop;

  const listenerId = store.addDidFinishTransactionListener((changedStore) => {
    const [cellsTouched, valuesTouched, changedCells, , changedValues] = changedStore.getTransactionLog();
    if (!cellsTouched && !valuesTouched) return;
    if (restoringPending) {
      // Counts only — never cell contents, which are list names, saved words
      // and search queries. `warn`, because reaching here means the restoration
      // above genuinely CHANGED something: a local write really had been erased
      // from the store the UI reads. The overwhelmingly common no-op
      // restoration never fires this listener at all.
      log.warn(
        'local-store: restored local writes erased by a concurrent load. TinyBase replaces the whole store ' +
          'content on an autoLoad poll, so writes not yet proven to be on disk were dropped from memory; they ' +
          'have been put back and are being re-saved.',
        { dbName, pendingTransactionCount: pendingSinceSave.length },
      );
    }
    const recorded: RecordedTransaction = { changedCells, changedValues };
    if (recordedDuringLoad) recordedDuringLoad.push(recorded);
    // The SAME object goes into both logs, so the load-end handler can drop the
    // load's own replace from the pending log by identity.
    pendingSinceSave.push(recorded);
    void triggerSave();
  });

  // Mechanism 3 (see this file's module doc): re-trigger the SAME coalescing
  // save the instant the page is hidden/backgrounded/closed, so a write that
  // is still mid-flight (or was about to start) gets its best remaining
  // chance to reach IndexedDB before the tab is torn down.
  const stopFlushOnHide = installFlushOnHide(triggerSave, { deps: flushOnHideDeps });

  let isStopped = false;

  return async () => {
    // IDEMPOTENT. `closePersistedStores` may be called twice (two sign-out
    // clicks, or a retry), and `delListener` on an already-removed id is not
    // something to rely on being harmless.
    if (isStopped) {
      await drain;
      return;
    }
    isStopped = true;

    // The listeners go first, so nothing can queue a NEW save while the drain
    // below is waiting for the current one.
    store.delListener(listenerId);
    stopWatchingLoads();
    stopFlushOnHide();
    await drain;
  };
}

// ---------------------------------------------------------------------------
// Mechanism 3: flush-on-hide — force the same coalescing autosave the moment
// the page is hidden/backgrounded/closed, on top of the per-write listener
// above (see this file's module doc for the incident this closes).
// ---------------------------------------------------------------------------

/**
 * Injectable seam for {@link installFlushOnHide} so its event-wiring behavior
 * (attach on install, detach on the returned unsubscribe, fire once per
 * event) is directly unit-testable without a real browser tab lifecycle.
 * `pagehide` is a `window` event; `visibilitychange` is a `document` event —
 * kept as separate add/remove pairs rather than a single "target" so a fake
 * can drive each independently in tests.
 */
export interface FlushOnHideDeps {
  addPageHideListener: (listener: () => void) => void;
  removePageHideListener: (listener: () => void) => void;
  addVisibilityChangeListener: (listener: () => void) => void;
  removeVisibilityChangeListener: (listener: () => void) => void;
  /** Whether the page is currently hidden — checked inside the `visibilitychange` handler, since that event also fires when the page becomes VISIBLE again. */
  isHidden: () => boolean;
}

/** `null` outside a browser (SSR, `node:test`) — {@link installFlushOnHide} then no-ops. */
function defaultFlushOnHideDeps(): FlushOnHideDeps | null {
  if (globalThis.window === undefined || globalThis.document === undefined) return null;
  return {
    addPageHideListener: (listener) => window.addEventListener('pagehide', listener),
    removePageHideListener: (listener) => window.removeEventListener('pagehide', listener),
    addVisibilityChangeListener: (listener) => document.addEventListener('visibilitychange', listener),
    removeVisibilityChangeListener: (listener) => document.removeEventListener('visibilitychange', listener),
    isHidden: () => document.visibilityState === 'hidden',
  };
}

/**
 * Installs the flush-on-hide safety net: calls `triggerSave` the moment the
 * page is about to be hidden or unloaded — on `pagehide` (fires on a tab
 * close or navigation away, and — unlike `unload` — fires reliably on mobile
 * Safari/iOS home-screen PWAs) and on `visibilitychange` when
 * `document.visibilityState` becomes `'hidden'` (covers app-switching/
 * backgrounding on mobile, which does not always fire `pagehide` first).
 * `beforeunload` is deliberately NOT used: it is unreliable on mobile Safari,
 * and on desktop merely registering a listener for it disables the page's
 * back/forward cache.
 *
 * WHAT THIS DOES NOT PROMISE: IndexedDB has no synchronous write API, so a
 * write that has not yet been INITIATED by the time the browser actually
 * discards the page's process can still be lost — no in-page JavaScript can
 * force that write to complete once the process is gone. What this closes is
 * the narrower, common window: a write already queued behind the save lock
 * (or whose `persister.save()` call hasn't started yet) gets kicked off right
 * away instead of waiting for whatever the store's own async chain happens to
 * have reached by the time the tab disappears — giving the browser its best
 * remaining chance to let that IndexedDB transaction finish. `triggerSave`
 * itself is the same coalescing function `startLockedAutoSave` already wires
 * to every store write, so this never queues a second, redundant save on top
 * of one already in flight.
 *
 * @returns An unsubscribe function that removes both listeners; a no-op function outside a browser.
 */
export function installFlushOnHide(
  triggerSave: () => Promise<void>,
  { deps = defaultFlushOnHideDeps() }: { deps?: FlushOnHideDeps | null } = {},
): () => void {
  if (!deps) return () => {};

  const onPageHide = (): void => {
    void triggerSave();
  };
  const onVisibilityChange = (): void => {
    if (deps.isHidden()) void triggerSave();
  };

  deps.addPageHideListener(onPageHide);
  deps.addVisibilityChangeListener(onVisibilityChange);

  return () => {
    deps.removePageHideListener(onPageHide);
    deps.removeVisibilityChangeListener(onVisibilityChange);
  };
}

// ---------------------------------------------------------------------------
// Mechanism 4 (see this file's module doc): prime a never-saved IndexedDB
// before this store's first `startAutoLoad()` poll, so that poll never hits
// the persister's own versionless-load-open/NotFoundError loop on a fresh
// device.
// ---------------------------------------------------------------------------

/**
 * Runs a one-time, empty `persister.save()` when {@link shouldPrimePersistedDb}
 * says `dbName` has never been persisted to, so the version-2 upgrade that
 * `save()` triggers (`createIndexedDbPersister`'s `setPersisted`, `create=1`)
 * creates the `"t"`/`"v"` object stores up front — see this file's module doc,
 * mechanism 4, for the looping NotFoundError this closes. Called BEFORE
 * `startAutoLoad` (this function's only caller, `initPersistedStore`, awaits
 * it first): the empty save cannot clobber anything (per
 * {@link shouldPrimePersistedDb}'s doc, `null` counts proves there is nothing
 * on disk yet to overwrite), and doing it before the load's own versionless
 * open means that very first load no longer hits the error either, not just
 * the ~1s polls after it.
 *
 * Goes through {@link runLockedSave} rather than a bare `persister.save()` so
 * two tabs opening the same never-saved store at once still only ever have
 * one save in flight at a time — the same Web Lock every other write in this
 * file uses.
 */
export async function primeFreshDatabaseIfNeeded(dbName: string, persister: SaveStep): Promise<void> {
  const countsBeforeLoad = await readPersistedTableRowCounts(dbName);
  if (!shouldPrimePersistedDb(countsBeforeLoad)) return;

  log.info(
    'local-store: priming a never-saved IndexedDB before its first load — creates the persister object stores up ' +
      'front so the autoLoad poll does not loop on NotFoundError until something first saves',
    { dbName },
  );
  await runLockedSave(dbName, persister);
}

// ---------------------------------------------------------------------------
// Store singletons
// ---------------------------------------------------------------------------

async function initPersistedStore(store: Store, dbName: string): Promise<Store> {
  assertBrowserWithIndexedDb(dbName);
  const persister = createIndexedDbPersister(store, dbName, undefined, (cause: unknown) => {
    // TinyBase itself swallows this error silently (no callback = discarded).
    // Surfacing it here is the difference between "diagnosable" and
    // "invisible" the next time a load or save fails partway through, should
    // one still slip past `primeFreshDatabaseIfNeeded` below (e.g. the prime
    // save itself failing for an unrelated reason). The genuinely alarming
    // case — data actually at risk — is `loadAndVerifyOrThrow`'s refusal
    // path below, which logs at `error`.
    log.warn(
      'local-store: IndexedDB persister load/save error (TinyBase treats this as non-fatal and continues; surfaced here for diagnosis)',
      { dbName, error: errorMessage(cause) },
    );
  });

  await primeFreshDatabaseIfNeeded(dbName, persister);

  await loadAndVerifyOrThrow(store, dbName, persister);

  // Every open tab persists its OWN writes from here on — synchronous setup,
  // no promise to await: this only installs a store-change listener, it
  // doesn't wait on winning anything. See `startLockedAutoSave`'s doc for why
  // this replaced the old single-elected-writer design (which silently
  // discarded every non-winning tab's writes — see this file's module doc).
  const stopAutoSave = startLockedAutoSave(store, dbName, persister);

  // BOTH TEARDOWNS ARE KEPT, and {@link closePersistedStores} is the only
  // caller. Nothing here shuts down during a normal page's life; sign-out is
  // the one moment this process has to let go of a database.
  openHandles.set(dbName, { persister, stopAutoSave });

  return store;
}

let primaryPromise: Promise<Store> | null = null;
let outboxPromise: Promise<Store> | null = null;

/**
 * What it takes to let go of one persisted store.
 *
 * `destroy` is narrowed to `void` rather than to TinyBase's own return (the
 * persister itself, for chaining). Nothing here chains, and a seam that
 * promised a persister back would have to name a vendor type this module
 * otherwise never mentions.
 */
interface OpenStoreHandle {
  persister: { destroy: () => void };
  /** Removes the listeners AND awaits the save that is running, in that order. See {@link closePersistedStores}. */
  stopAutoSave: () => Promise<void>;
}

/** The persisters this page has started, by database name. Empty until a store is first resolved. */
const openHandles = new Map<string, OpenStoreHandle>();

/**
 * Lets go of every persisted store this page has opened.
 *
 * WHY SIGN-OUT CANNOT SKIP THIS, and why deleting the databases without it does
 * nothing at all. `createIndexedDbPersister` runs an AUTO-LOAD POLL once a
 * second, and each poll opens the database VERSIONLESS (`create=0`). So a
 * `deleteDatabase` that succeeds is followed, within a second, by a poll that
 * re-creates the very database that was just removed, as an empty v1 with no
 * object stores at all. The poll is also what makes a delete arrive `blocked`.
 *
 * ── The order inside it is the fix, and it is not obvious ─────────────────
 *
 * A first version destroyed each persister immediately and nulled the two
 * singletons first. A browser walk on 2026-09-04 found both faults it has:
 *
 *   1. `persister.destroy()` while one of that persister's own scheduled
 *      actions is in flight tears the action schedule out from under it, and
 *      the running action's `finally` then splices an array the destroy has
 *      already emptied: `locked autosave failed ... Cannot read properties of
 *      undefined (reading 'splice')`. So the SAVE IS DRAINED FIRST, by the
 *      teardown `startLockedAutoSave` returns, and only then is the persister
 *      destroyed.
 *   2. Nulling `primaryPromise` before awaiting anything means a caller that
 *      resolves the store during those awaits builds a BRAND NEW persister on
 *      the same database, whose poll re-creates it moments later. So the
 *      singletons are nulled LAST, and a handle leaves {@link openHandles}
 *      only once its own teardown has finished.
 *
 * IT IS IDEMPOTENT AND SINGLE-FLIGHT. Two sign-out clicks, or a retry, share
 * one run rather than racing two teardowns over the same persisters.
 *
 * THE SINGLETONS ARE RESET, so a later read rebuilds from an empty database
 * rather than handing out a store whose persister is dead. That is the correct
 * state after a sign-out: the same one a browser that has never opened this app
 * is in.
 *
 * @returns the database names it let go of.
 */
export async function closePersistedStores(): Promise<string[]> {
  closingPromise ??= closeEveryPersistedStore();
  try {
    return await closingPromise;
  } finally {
    closingPromise = null;
  }
}

/** The single-flight slot for {@link closePersistedStores}. */
let closingPromise: Promise<string[]> | null = null;

/** The body of {@link closePersistedStores}. Separated so the single-flight guard above reads as one line. */
async function closeEveryPersistedStore(): Promise<string[]> {
  const closed: string[] = [];

  // The map is NOT cleared up front. A handle is removed only after its own
  // teardown resolved, so nothing that is still running is ever reachable
  // through a structure this function already emptied. Deleting the CURRENT
  // entry while iterating a `Map` is defined behaviour, and an entry added
  // during one of the awaits below is visited too, which is what should happen
  // to a store that was opened mid-close.
  for (const [dbName, handle] of openHandles) {
    // Drains the in-flight save and removes the listeners. It never throws:
    // `runSaveLoop` logs its own failures.
    await handle.stopAutoSave();
    await handle.persister.destroy();
    openHandles.delete(dbName);
    closed.push(dbName);
  }

  // LAST, for the reason in the doc above: a caller that resolves a store
  // while the awaits above are pending must get the store being torn down,
  // not a fresh persister on the database that is about to be deleted.
  primaryPromise = null;
  outboxPromise = null;
  return closed;
}

/**
 * The lazily-created, IndexedDB-backed PRIMARY store — the durable home for
 * lists, list items, notes and the device-only search log. Its own IndexedDB
 * database, wholly independent of the outbox, so no cache-eviction path can
 * ever touch it. Throws if resolved outside a browser with IndexedDB support
 * (see `assertBrowserWithIndexedDb`) OR if a suspected failed/partial load was
 * detected (see `loadAndVerifyOrThrow`) — in either case the failed promise is
 * NOT cached, so the next call retries from scratch rather than being stuck
 * permanently rejected.
 */
export function getPrimaryStore(): Promise<Store> {
  if (!primaryPromise) {
    primaryPromise = initPersistedStore(createPrimaryStore(), PRIMARY_DB_NAME).catch((cause: unknown) => {
      primaryPromise = null;
      throw cause;
    });
  }
  return primaryPromise;
}

/**
 * The lazily-created, IndexedDB-backed outbox store. Throws if resolved
 * outside a browser with IndexedDB support (see `assertBrowserWithIndexedDb`)
 * OR if a suspected failed/partial load was detected (see
 * `loadAndVerifyOrThrow`) — in either case the failed promise is NOT cached,
 * so the next call retries from scratch.
 */
export function getOutboxStore(): Promise<Store> {
  if (!outboxPromise) {
    outboxPromise = initPersistedStore(createOutboxStore(), OUTBOX_DB_NAME).catch((cause: unknown) => {
      outboxPromise = null;
      throw cause;
    });
  }
  return outboxPromise;
}
