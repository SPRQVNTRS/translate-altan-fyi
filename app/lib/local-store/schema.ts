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
 * THREE OF THE FOUR ENTITIES ARE SYNCED, AND ONE IS NOT. Lists, list items and
 * notes carry a {@link SyncStamp} and are what the encrypted blob transports
 * (`app/lib/e2ee/BLOB-CONTENTS.md`). Search entries are device-only: they carry
 * no stamp, are hard-deleted rather than tombstoned, and are capped on the
 * device. A reader who assumes the fourth table behaves like the first three
 * will get both the deletion semantics and the blob contents wrong.
 */

/** The on-disk shape version, stamped into every backup envelope. */
export const SCHEMA_VERSION = 1;

/** Vocabulary lists table: one row per list, keyed by the list's `id`. */
export const LISTS_TABLE = 'lists';
/** List entries table: one row per saved entry, keyed by the entry's `id`. */
export const LIST_ITEMS_TABLE = 'listItems';
/** Personal notes table: one row per note, keyed by the note's `id`. */
export const NOTES_TABLE = 'notes';
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
  history: LocalHistoryEntry[];
}

/** The most recorded searches a device keeps, oldest dropped first. */
export const HISTORY_MAX_ENTRIES = 500;
/** The oldest a recorded search may be before it is dropped, in days. */
export const HISTORY_MAX_AGE_DAYS = 90;
/** Both halves of the cap as one value, so a caller cannot apply one and forget the other — see `history.ts`'s `pruneHistory`. */
export const HISTORY_CAP = { count: HISTORY_MAX_ENTRIES, days: HISTORY_MAX_AGE_DAYS } as const;
