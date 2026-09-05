/**
 * COPIED, NOT SHARED. Source: openplate/app/lib/local-store/backup.ts @ 68e893a.
 * See .adr/0008-e2ee-sync-copied-not-extracted.md. Fixes belong upstream first,
 * then here. Do not let the two drift.
 *
 * Schema-versioned backup: a full-fidelity JSON export/import of the primary
 * store, plus the "days since last export" tracking that drives the backup
 * nudge. The whole device — lists, list items, notes, review state, favourites
 * and the search log — round-trips losslessly through a device-local file, and the envelope's
 * `schemaVersion` lets an export taken on an older build migrate forward on
 * import.
 *
 * THE EXPORT CARRIES EVERY COLLECTION, INCLUDING SEARCH HISTORY, AND THE
 * SYNC BLOB DOES NOT. That is not an inconsistency, it is the distinction the
 * two things are for. A JSON export is the user's own file, written to their
 * own device, and the whole point of it is that they own everything — a backup
 * that quietly dropped a collection would be a backup that lies. The blob is a
 * thing SENT TO A SERVER, so what goes in it is decided by a different
 * question, answered in `app/lib/local-store/BLOB-CONTENTS.md`.
 *
 * Split: `serializeBackup`/`parseBackupEnvelope`/`migrateEnvelopeForward` are
 * pure (no store, no browser) so they unit-test directly; `exportBackup`/
 * `importBackup`/`restoreBackup` and the nudge readers are the thin store shell.
 */
import { z } from 'zod';
import type { Store } from 'tinybase';
import { LAST_EXPORT_VALUE } from './store';
import { SCHEMA_VERSION } from './schema';
import type { LocalStoreSnapshot } from './schema';
import { getPrimaryStore } from './persist';
import {
  listLocalListItemsIncludingDeleted,
  listLocalListsIncludingDeleted,
  listLocalNotesIncludingDeleted,
  listLocalReviewStateIncludingDeleted,
  putLocalList,
  putLocalListItem,
  putLocalNote,
  putLocalReviewState,
} from './primary-store';
import { listFavoritesIncludingDeleted, putFavorite } from './favorites';
import { importHistoryEntries, listHistory } from './history';

/** A device-local backup file: the schema version, the export instant, and the data. */
export interface BackupEnvelope {
  /** The schema version the `data` was exported under (see `SCHEMA_VERSION`). */
  schemaVersion: number;
  /** ISO-8601 instant the export was taken (informational; not used for equality). */
  exportedAt: string;
  /** The full device snapshot. */
  data: LocalStoreSnapshot;
}

// ---------------------------------------------------------------------------
// Validation schema (mirrors the entity shapes in `schema.ts`)
// ---------------------------------------------------------------------------

/** The ordering stamp every synced entity carries. */
const syncStampFields = {
  lamport: z.number().int().nonnegative(),
  deviceId: z.string().min(1),
  updatedAt: z.number().int(),
  deleted: z.boolean(),
} as const;

const listSchema = z.object({
  ...syncStampFields,
  id: z.string(),
  name: z.string(),
  languagePair: z.string(),
});

const listItemSchema = z.object({
  ...syncStampFields,
  id: z.string(),
  listId: z.string(),
  headwordId: z.string(),
  senseId: z.string().nullable(),
  lemma: z.string(),
  translationSnapshot: z.string(),
  note: z.string(),
});

const noteSchema = z.object({
  ...syncStampFields,
  id: z.string(),
  headwordId: z.string(),
  text: z.string(),
});

/** What the flashcard loop recorded about one saved word, keyed by the list entry's id. */
const reviewStateSchema = z.object({
  ...syncStampFields,
  id: z.string(),
  gotItCount: z.number().int().nonnegative(),
  stillLearningCount: z.number().int().nonnegative(),
  lastReviewedAt: z.number().int(),
});

/** One word kept with a single tap. Its `id` folds the key it is addressed by; see `favorites.ts`. */
const favoriteSchema = z.object({
  ...syncStampFields,
  id: z.string(),
  headwordId: z.string(),
  senseId: z.string().nullable(),
  lemma: z.string(),
  translationSnapshot: z.string(),
  from: z.string(),
  to: z.string(),
});

const historyEntrySchema = z.object({
  id: z.string(),
  query: z.string(),
  from: z.string(),
  to: z.string(),
  headwordId: z.string().nullable(),
  /**
   * Defaulted rather than required, so a file exported by a build that
   * predates the field still imports. "That device recorded no answer" is the
   * honest reading of a missing key, and it is the same state a search
   * recorded before its answer arrived is already in.
   */
  translation: z.string().nullable().default(null),
  at: z.number().int(),
});

/**
 * Each collection defaults to empty, which is how a future new collection
 * arrives without making every existing backup file un-importable: an older
 * envelope simply lacks the key, and "this device had none, because they did
 * not exist" is the honest reading of that.
 */
const snapshotSchema = z.object({
  lists: z.array(listSchema).default([]),
  listItems: z.array(listItemSchema).default([]),
  notes: z.array(noteSchema).default([]),
  reviewState: z.array(reviewStateSchema).default([]),
  favorites: z.array(favoriteSchema).default([]),
  history: z.array(historyEntrySchema).default([]),
});

/**
 * The WRAPPER shape shared by every envelope version — schema-agnostic about
 * `data`. This is deliberately the ONLY thing `parseBackupEnvelope` validates;
 * see the ordering note on `migrateEnvelopeForward` below for why.
 */
const rawEnvelopeSchema = z.object({
  schemaVersion: z.number().int(),
  exportedAt: z.string(),
  data: z.unknown(),
});

/** A parsed-but-not-yet-migrated envelope: the version is known, the payload shape is not (yet). */
export type RawBackupEnvelope = z.infer<typeof rawEnvelopeSchema>;

// ---------------------------------------------------------------------------
// Pure serialize / parse / migrate
// ---------------------------------------------------------------------------

/** Serializes an envelope to the JSON string a download writes. Pure. */
export function serializeBackup(envelope: BackupEnvelope): string {
  return JSON.stringify(envelope);
}

/**
 * Parses a backup JSON string into a `RawBackupEnvelope`, validating ONLY the
 * version-agnostic wrapper (`schemaVersion`/`exportedAt`/`data` presence) — not
 * the shape of `data` itself. Throws a clear error on anything malformed (fail
 * fast — a bad backup file must never partly import). Pure.
 *
 * ORDERING: this deliberately does NOT validate `data` against the CURRENT,
 * full `snapshotSchema`, which would reject a genuinely OLDER envelope before
 * `migrateEnvelopeForward` ever got a chance to upgrade it. Validating only the
 * wrapper here, and validating the migrated payload's final shape inside
 * `migrateEnvelopeForward` (AFTER the version-specific upgrade steps run),
 * means older envelopes reach the migration step instead of being
 * short-circuited by a check written for the current version. Upstream learned
 * this the hard way, in review; the ordering is carried across with the code.
 */
export function parseBackupEnvelope(json: string): RawBackupEnvelope {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    throw new Error('Invalid backup file: not valid JSON.');
  }
  const result = rawEnvelopeSchema.safeParse(raw);
  if (!result.success) {
    throw new Error(`Invalid backup file: ${result.error.issues[0]?.message ?? 'unrecognized shape'}.`);
  }
  return result.data;
}

/**
 * Migrates a `RawBackupEnvelope` forward to the current `SCHEMA_VERSION`,
 * validating the FINAL payload shape only AFTER any version-specific upgrade
 * steps have run (see the ordering note on `parseBackupEnvelope`). A
 * newer-than-supported envelope is rejected up front, since this build can't
 * know how to safely down-convert it. Pure.
 *
 * THE CHAIN STILL HAS NO LINKS, AND THAT IS A PROPERTY OF BOTH BUMPS SO FAR
 * RATHER THAN AN OVERSIGHT. v2 only ADDED the review-state collection and v3
 * only added favourites, and
 * `snapshotSchema` defaults every collection to empty, so a v1 or a v2 file
 * validates as it stands and reads as "this device had none of that" — which is
 * exactly what was true when it was written. A bump that RENAMES or RESHAPES a
 * field cannot be absorbed that way, and that is the one that gets a step
 * here. Per-version steps slot in below, each transforming `migratedData` from
 * the previous version's shape into the next, in turn, BEFORE the final
 * validation.
 */
export function migrateEnvelopeForward(envelope: RawBackupEnvelope): BackupEnvelope {
  if (envelope.schemaVersion > SCHEMA_VERSION) {
    throw new Error(
      `Backup is schema v${envelope.schemaVersion}, newer than this app supports (v${SCHEMA_VERSION}). Update the app to import it.`,
    );
  }
  // Per-version upgrade steps slot in here as the schema evolves.
  const migratedData = envelope.data;

  const result = snapshotSchema.safeParse(migratedData);
  if (!result.success) {
    throw new Error(
      `Backup migration failed: ${result.error.issues[0]?.message ?? 'payload does not match the current schema'}.`,
    );
  }
  return { schemaVersion: SCHEMA_VERSION, exportedAt: envelope.exportedAt, data: result.data };
}

// ---------------------------------------------------------------------------
// Store shell: export / import
// ---------------------------------------------------------------------------

async function resolveStore(store: Store | undefined): Promise<Store> {
  return store ?? (await getPrimaryStore());
}

/**
 * Reads the full device snapshot from the primary store (deterministic order).
 * Tombstones are INCLUDED: a backup that dropped them would restore a device
 * that then resurrects, on its next pull, every entity the person had deleted.
 */
async function readSnapshot(store?: Store): Promise<LocalStoreSnapshot> {
  return {
    lists: await listLocalListsIncludingDeleted({ store }),
    listItems: await listLocalListItemsIncludingDeleted({ store }),
    notes: await listLocalNotesIncludingDeleted({ store }),
    reviewState: await listLocalReviewStateIncludingDeleted({ store }),
    favorites: await listFavoritesIncludingDeleted({ store }),
    history: await listHistory({ store }),
  };
}

/**
 * Whether the primary store currently holds ANY data. This is the `hasData`
 * signal a backup nudge needs to nudge a device that has never exported (the
 * population most at risk of losing its only copy) WITHOUT nagging a genuinely
 * brand-new, still-empty device that has nothing to lose yet.
 */
export async function hasAnyLocalData({ store }: { store?: Store } = {}): Promise<boolean> {
  const snapshot = await readSnapshot(store);
  return (
    snapshot.lists.length > 0 ||
    snapshot.listItems.length > 0 ||
    snapshot.notes.length > 0 ||
    snapshot.reviewState.length > 0 ||
    snapshot.favorites.length > 0 ||
    // A search log alone counts. It is the one thing a person can accumulate
    // without ever having saved anything, and it is still theirs.
    snapshot.history.length > 0
  );
}

/**
 * Upserts every entity in a snapshot into the primary store (non-destructive).
 *
 * The synced entities go back through `putLocal*`, which RE-STAMPS them: the
 * restored row gets this device's id and a fresh lamport, which is correct —
 * this device is asserting the row, and a peer that has since deleted it must
 * not silently win.
 *
 * The search log goes back too, through `importHistoryEntries`, which merges by
 * id and re-applies the cap. It would have been easy to leave it out, on the
 * grounds that it is device-only — and that would have made this a restore that
 * drops a collection the export it just read had faithfully carried.
 */
async function importSnapshot(snapshot: LocalStoreSnapshot, store?: Store): Promise<void> {
  for (const list of snapshot.lists) await putLocalList(list, { store });
  for (const item of snapshot.listItems) await putLocalListItem(item, { store });
  for (const note of snapshot.notes) await putLocalNote(note, { store });
  for (const reviewState of snapshot.reviewState) await putLocalReviewState(reviewState, { store });
  // `putFavorite` DERIVES the id from the row rather than taking the one in the
  // file, which is not a loss: the derivation is a pure function of the three
  // fields beside it, so a row written by this app restores under exactly the
  // id it was exported with. A row whose id was edited by hand restores under
  // the id its own fields say it should have, which is the honest reading.
  for (const favorite of snapshot.favorites) await putFavorite(favorite, { store });
  await importHistoryEntries(snapshot.history, { store });
}

/** Builds a schema-versioned export envelope from the primary store's current data. */
export async function exportBackup({ store, now }: { store?: Store; now?: () => Date } = {}): Promise<BackupEnvelope> {
  const clock = now ?? (() => new Date());
  return {
    schemaVersion: SCHEMA_VERSION,
    exportedAt: clock().toISOString(),
    data: await readSnapshot(store),
  };
}

/**
 * Imports a (possibly older-version) envelope into the primary store, migrating
 * it forward first. Upsert semantics: existing rows with matching ids are
 * overwritten, others are added — a restore into a fresh store is exact, and a
 * restore into a populated store merges.
 */
export async function importBackup(envelope: BackupEnvelope, { store }: { store?: Store } = {}): Promise<void> {
  const migrated = migrateEnvelopeForward(envelope);
  await importSnapshot(migrated.data, store);
}

/** Parses a backup JSON string and restores it into the primary store. Returns the migrated envelope. */
export async function restoreBackup(json: string, { store }: { store?: Store } = {}): Promise<BackupEnvelope> {
  const migrated = migrateEnvelopeForward(parseBackupEnvelope(json));
  await importSnapshot(migrated.data, store);
  return migrated;
}

// ---------------------------------------------------------------------------
// Backup nudge: last-export tracking
// ---------------------------------------------------------------------------

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Whole days between an export instant and `now`; null when never exported. Pure. */
export function computeDaysSinceExport(lastExportMs: number | null, nowMs: number): number | null {
  if (lastExportMs === null) return null;
  return Math.max(0, Math.floor((nowMs - lastExportMs) / MS_PER_DAY));
}

/** The last-export instant as it comes back off the store — a TinyBase value, not yet an epoch-ms. */
const lastExportValueSchema = z.number();

/** Records that the user has just exported a backup (stamps the last-export instant). */
export async function markExported({ store, now }: { store?: Store; now?: () => number } = {}): Promise<void> {
  const clock = now ?? Date.now;
  (await resolveStore(store)).setValue(LAST_EXPORT_VALUE, clock());
}

/** The epoch-ms of the last export, or null when the user has never exported. */
export async function getLastExportAt({ store }: { store?: Store } = {}): Promise<number | null> {
  const value = lastExportValueSchema.safeParse((await resolveStore(store)).getValue(LAST_EXPORT_VALUE));
  return value.success ? value.data : null;
}

/**
 * Whole days since the last backup export, or null when never exported — the
 * datum a nudge banner ("you have N days of un-exported data") reads.
 */
export async function daysSinceExport({ store, now }: { store?: Store; now?: () => number } = {}): Promise<
  number | null
> {
  const clock = now ?? Date.now;
  return computeDaysSinceExport(await getLastExportAt({ store }), clock());
}
