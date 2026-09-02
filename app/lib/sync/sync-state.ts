/**
 * COPIED, NOT SHARED. Source: openplate/app/lib/sync/sync-state.ts @ 68e893ac71d25ad7ff42280773ea0ec94f4f700e.
 * See .adr/0008-e2ee-sync-copied-not-extracted.md. Fixes belong upstream first,
 * then here. Do not let the two drift.
 */
/**
 * The device-local sync bookkeeping: which blob version this device last
 * agreed with, and when.
 *
 * WHY NOT IN THE TINYBASE STORE: this is not user data. It is derived state
 * that can be thrown away and rebuilt, it must never appear in a backup export
 * or inside a sync blob, and — most usefully — keeping it out of the primary
 * store means the orchestrator never has to interleave with `persist.ts`'s
 * save lock to read or write it. See `sync-lock.ts` for why that matters.
 *
 * NOTHING SECRET LIVES HERE. Not the passphrase, not the DEK, not a token.
 * A blob version and a timestamp, both derived and both useless to anyone who
 * reads them.
 *
 * The storage is behind an interface so the unit and integration suites can
 * run this without a browser — `localStorage` does not exist in `node:test`.
 *
 * ── TWO THINGS THE SOURCE HAS AND THIS DOES NOT ───────────────────────────
 *
 * **The baseline is gone.** Upstream `PersistedSyncState` also carried a
 * `baseline`: per-entity content hashes that `snapshot-sync.ts` re-derived
 * every entity's Lamport stamp from, by diffing the current snapshot against
 * it on each cycle. Here the stamp is written onto the row at mutation time by
 * `primary-store.ts`'s write helpers, so there is nothing to diff and no
 * baseline to keep in step with the store it measures. What that buys is the
 * failure mode: losing this state now costs ONE REDUNDANT PUSH, where losing
 * a baseline upstream could leave a device quietly declining to upload data it
 * is the only copy of.
 *
 * **`resolveDeviceId` is gone from this module.** It lives in
 * `app/lib/local-store/primary-store.ts` and is stored as a VALUE in the
 * primary IndexedDB store rather than in `localStorage`, so it shares the
 * lifetime of the entities it stamps: a browser that clears site storage
 * clears both, and a device cannot come back holding an id whose entities are
 * gone.
 */
import { z } from 'zod';

/** Bumped only if the shape below changes incompatibly; an unreadable state is simply discarded and rebuilt. */
const STATE_FORMAT_VERSION = 1;

const STATE_KEY_PREFIX = 'translate.sync.state.v1';

export interface PersistedSyncState {
  formatVersion: number;
  /** The `blobVersion` this device last successfully agreed with. `0` means "never synced". */
  lastBlobVersion: number;
  /** Epoch-ms of the last successful cycle, for the "last synced" line in the UI. `null` until the first one. */
  lastSyncedAt: number | null;
}

/** Just enough storage for this module — `localStorage`'s shape, minus everything unused. */
export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface SyncStateStore {
  load(): PersistedSyncState;
  save(state: PersistedSyncState): void;
  clear(): void;
}

/** The state a device that has never synced starts from: no version, nothing agreed with. */
export function emptySyncState(): PersistedSyncState {
  return { formatVersion: STATE_FORMAT_VERSION, lastBlobVersion: 0, lastSyncedAt: null };
}

/**
 * State is keyed BY ACCOUNT.
 *
 * Signing into a different account on the same device must not inherit the
 * previous account's blob version: a `lastBlobVersion` from another account's
 * blob describes a compare-and-swap sequence this account never took part in,
 * and carrying it over would make the first push of the new account argue
 * about a version that was never its own.
 */
export function createSyncStateStore({
  storage,
  accountId,
}: {
  storage: KeyValueStorage;
  accountId: number;
}): SyncStateStore {
  const key = `${STATE_KEY_PREFIX}:${accountId}`;
  return {
    load(): PersistedSyncState {
      const raw = storage.getItem(key);
      if (raw === null) return emptySyncState();
      return parseSyncState(raw);
    },
    save(state: PersistedSyncState): void {
      storage.setItem(key, JSON.stringify(state));
    },
    clear(): void {
      storage.removeItem(key);
    },
  };
}

/**
 * The persisted form, as read back out of storage.
 *
 * `lastBlobVersion`/`lastSyncedAt` default rather than reject: losing a
 * timestamp is cosmetic, and a missing version simply means "push everything",
 * which is already the safe direction.
 */
const persistedSyncStateSchema = z.object({
  formatVersion: z.literal(STATE_FORMAT_VERSION),
  lastBlobVersion: z.number().catch(0),
  lastSyncedAt: z.number().nullable().catch(null),
});

/**
 * Parses persisted state, falling back to empty on ANYTHING unrecognizable.
 *
 * Fail-soft is right here and nowhere else in this feature: a corrupt state
 * costs one redundant full push, whereas throwing would leave a device unable
 * to sync at all until someone cleared their browser storage by hand. Contrast
 * `parseEnvelope`, where a malformed input means "do not touch this data".
 */
export function parseSyncState(raw: string): PersistedSyncState {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return emptySyncState();
  }
  const state = persistedSyncStateSchema.safeParse(parsed);
  if (!state.success) return emptySyncState();
  return {
    formatVersion: STATE_FORMAT_VERSION,
    lastBlobVersion: state.data.lastBlobVersion,
    lastSyncedAt: state.data.lastSyncedAt,
  };
}

/** `localStorage` when there is one, otherwise `null` — SSR and `node:test` both take the `null` branch. */
export function browserStorage(): KeyValueStorage | null {
  if (globalThis.localStorage === undefined) return null;
  return localStorage;
}

/**
 * The in-memory stand-in used when there is no `localStorage` — SSR, a
 * locked-down browser, a `node:test` run.
 *
 * A MODULE SINGLETON, not a fresh store per call. A new store each time would
 * lose the last agreed blob version between two calls in the same page, so
 * every sync would look like a first sync — quietly turning "no localStorage"
 * into "re-upload everything, forever".
 */
const fallbackStorage = createMemoryStorage();

/** The device's key-value storage: `localStorage` where it exists, one shared in-memory store where it doesn't. */
export function deviceStorage(): KeyValueStorage {
  return browserStorage() ?? fallbackStorage;
}

/** An in-memory {@link KeyValueStorage}, for tests and for the SSR/no-storage fallback. */
export function createMemoryStorage(initial: Record<string, string> = {}): KeyValueStorage {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => void map.set(key, value),
    removeItem: (key) => void map.delete(key),
  };
}
