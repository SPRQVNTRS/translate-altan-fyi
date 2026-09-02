/**
 * COPIED, NOT SHARED. Source: openplate/app/lib/local-store/schema.ts @ 68e893a.
 * See .adr/0008-e2ee-sync-copied-not-extracted.md. Fixes belong upstream first,
 * then here. Do not let the two drift.
 *
 * Versioned local schema — the structural source of truth for the on-device
 * primary store. This module defines the durable, authoritative home for a
 * person's vocabulary lists, the entries in them, the notes they wrote for
 * themselves, and the searches they ran. Every entity is stored as one JSON
 * cell per row, so a row is read/written whole and complex fields survive a
 * round-trip untouched.
 *
 * `SCHEMA_VERSION` is stamped into every backup envelope (`backup.ts`) so an
 * export taken on an older app build can be migrated forward on import. Bump it
 * (and add a forward migration in `backup.ts`) whenever an entity shape changes.
 *
 * Pure types + id constants only — no runtime deps beyond `import type`, so the
 * pure logic modules (`backup.ts`, `blob-schema.ts`) and their unit tests stay
 * browser- and store-free.
 *
 * FOUR OF THE FIVE ENTITIES ARE SYNCED, AND ONE IS NOT. Lists, list items,
 * notes and review state carry a {@link SyncStamp} and are what the encrypted
 * blob transports (`app/lib/e2ee/BLOB-CONTENTS.md`). Search entries are
 * device-only: they carry no stamp, are hard-deleted rather than tombstoned,
 * and are capped on the device. A reader who assumes the search table behaves
 * like the other four will get both the deletion semantics and the blob
 * contents wrong.
 */

/**
 * The on-disk shape version, stamped into every backup envelope AND bound into
 * the blob's AAD.
 *
 * v2 added {@link LocalReviewState}. Nothing else changed, and the addition is
 * why no upgrade STEP was needed: every collection in `backup.ts` and in
 * `blob-schema.ts` defaults to empty, so a v1 file or a v1 blob reads as "that
 * device had no review state", which is exactly true. The orchestrator's
 * schema probe (`app/lib/sync/orchestrator.ts`) walks the AAD down from here
 * to 1, so a peer still on v1 stays readable.
 */
export const SCHEMA_VERSION = 2;

/** Vocabulary lists table: one row per list, keyed by the list's `id`. */
export const LISTS_TABLE = 'lists';
/** List entries table: one row per saved entry, keyed by the entry's `id`. */
export const LIST_ITEMS_TABLE = 'listItems';
/** Personal notes table: one row per note, keyed by the note's `id`. */
export const NOTES_TABLE = 'notes';
/** Review state table: one row per reviewed list entry, keyed by THAT ENTRY's id. */
export const REVIEW_STATE_TABLE = 'reviewState';
/** Search log table: one row per recorded search, keyed by the entry's `id`. Device-only. */
export const HISTORY_TABLE = 'history';
/** The single JSON cell every primary row uses to hold its serialized entity. */
export const PRIMARY_ENTITY_CELL = 'entity';

/** Store-level value holding the schema version the store was last written under. */
export const SCHEMA_VERSION_VALUE = 'schemaVersion';
/** Store-level value holding the epoch-ms of the last backup export. */
export const LAST_EXPORT_VALUE = 'lastExportAt';
/** Store-level value holding this device's stable id — see `primary-store.ts`'s `resolveDeviceId`. */
export const DEVICE_ID_VALUE = 'deviceId';
/** Store-level value holding the owner id the migration gate was last cleared for on this device. */
export const MIGRATION_GATE_CLEARED_FOR_VALUE = 'migrationGateClearedFor';
/**
 * Store-level value holding the LOCAL calendar date, `YYYY-MM-DD`, the daily
 * nudge was last shown on this device.
 *
 * A VALUE, NOT A ROW, AND DEVICE-ONLY. It is not an entity, it carries no
 * {@link SyncStamp}, and it never enters the encrypted blob: `blob-schema.ts`
 * projects the four synced COLLECTIONS and values are not among them, which is
 * asserted in `tests/unit/personal/blob-serializer.test.ts`. Syncing it would
 * mean a phone opened at breakfast silences the laptop opened at lunch, and a
 * nudge is per device the same way a screen is.
 *
 * THE DEVICE'S OWN CALENDAR DATE, NOT AN INSTANT. A day boundary here is the
 * reader's midnight, wherever they are, and there is no server to ask: the
 * device may be offline all day. See `nudge.ts` for the formatting and the
 * comparison.
 */
export const NUDGE_SHOWN_ON_VALUE = 'nudgeShownOn';

/** The per-entity ordering stamp, PROTOCOL.md section 3.3. Higher lamport wins; ties break on lexicographic deviceId. */
export interface SyncStamp {
  lamport: number;
  deviceId: string;
  /** Epoch-ms of the last local write. Informational for the UI ONLY: wall clock is never an ordering authority. */
  updatedAt: number;
  /** A soft delete. The row stays so the tombstone can be pushed; readers must filter it out. */
  deleted: boolean;
}

/** One vocabulary list. */
export interface LocalList extends SyncStamp {
  id: string;
  name: string;
  languagePair: string;
}

/** One saved entry in a vocabulary list. */
export interface LocalListItem extends SyncStamp {
  id: string;
  listId: string;
  headwordId: string;
  /** The sense the user picked, or null when the entry had none. */
  senseId: string | null;
  lemma: string;
  /** The translation AS IT READ WHEN SAVED. A snapshot, deliberately: re-enrichment must not silently rewrite what someone chose to learn. */
  translationSnapshot: string;
  note: string;
}

/** One note a person wrote for themselves against a headword. */
export interface LocalNote extends SyncStamp {
  id: string;
  headwordId: string;
  text: string;
}

/**
 * What a person's flashcard sessions have recorded about one saved word.
 *
 * THE `id` IS THE LIST ENTRY'S `id`, NOT A SEPARATE KEY. One saved word has
 * exactly one review state, so a second identifier would be a second thing
 * that can disagree with the first. Sharing the id also makes the merge's
 * namespaced key (`reviewState:<id>`) line up with the entry's own
 * (`listItem:<id>`) without either colliding.
 *
 * THERE ARE NO SCHEDULING FIELDS HERE, AND THAT IS THE DESIGN, NOT A GAP. No
 * ease factor, no gap length, no due instant. A verdict tally and the last
 * instant reviewed are all the review loop reads, because the loop reorders
 * within one session and never schedules a future one. Adding a schedule is a
 * product decision, and it would arrive with its own migration.
 *
 * `lastReviewedAt` is informational, like `updatedAt`: wall clock is never an
 * ordering authority here either.
 */
export interface LocalReviewState extends SyncStamp {
  id: string;
  gotItCount: number;
  stillLearningCount: number;
  lastReviewedAt: number;
}

/**
 * One recorded search. CLIENT-ONLY: no {@link SyncStamp}, because this never
 * crosses a device boundary and so has nothing to converge with.
 */
export interface LocalHistoryEntry {
  id: string;
  query: string;
  from: string;
  to: string;
  headwordId: string | null;
  /** Epoch-ms the search ran. This IS the ordering key here, which is sound because history never crosses a device boundary. */
  at: number;
}

/**
 * The full device shape: every collection this store holds, including the
 * device-only one. This is what the JSON export carries. The SYNC payload is a
 * different, narrower shape — see `blob-schema.ts`.
 */
export interface LocalStoreSnapshot {
  lists: LocalList[];
  listItems: LocalListItem[];
  notes: LocalNote[];
  reviewState: LocalReviewState[];
  history: LocalHistoryEntry[];
}

/** The most recorded searches a device keeps, oldest dropped first. */
export const HISTORY_MAX_ENTRIES = 500;
/** The oldest a recorded search may be before it is dropped, in days. */
export const HISTORY_MAX_AGE_DAYS = 90;
/** Both halves of the cap as one value, so a caller cannot apply one and forget the other — see `history.ts`'s `pruneHistory`. */
export const HISTORY_CAP = { count: HISTORY_MAX_ENTRIES, days: HISTORY_MAX_AGE_DAYS } as const;
