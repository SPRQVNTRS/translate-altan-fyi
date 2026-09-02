/**
 * COPIED, NOT SHARED. Source: openplate/app/lib/local-store/store.ts @ 68e893a.
 * See .adr/0008-e2ee-sync-copied-not-extracted.md. Fixes belong upstream first,
 * then here. Do not let the two drift.
 *
 * TinyBase store definitions and ids — the single home for the local layer's
 * table/cell identifiers and store factories. `createStore()` is pure JS (no
 * browser needed), so these factories are usable in SSR and in unit tests
 * against a real in-memory store; IndexedDB persistence is layered on in
 * `persist.ts`.
 */
import { createStore, type Store } from 'tinybase';

// The primary store's structural ids live in `schema.ts` (the versioned schema).
// They are re-exported here so this module stays the single lookup point for
// every local-store table/cell id — the primary tables (lists, list items,
// notes, and the device-only search log) alongside the outbox table below.
export {
  LISTS_TABLE,
  LIST_ITEMS_TABLE,
  NOTES_TABLE,
  HISTORY_TABLE,
  PRIMARY_ENTITY_CELL,
  SCHEMA_VERSION_VALUE,
  LAST_EXPORT_VALUE,
  DEVICE_ID_VALUE,
  MIGRATION_GATE_CLEARED_FOR_VALUE,
} from './schema';

/**
 * IndexedDB database name for the PRIMARY store — the durable, authoritative
 * home for lists, list items, notes, and the device-only search log. Distinct
 * from the outbox so it is never swept by any cache-eviction path.
 */
export const PRIMARY_DB_NAME = 'translate-primary';
/** IndexedDB database name for the write outbox store. */
export const OUTBOX_DB_NAME = 'translate-outbox';

/** Outbox table: one row per queued sync intent, keyed by the record's `clientId`. */
export const OUTBOX_TABLE = 'outbox';
/** Cell holding the JSON-serialized `OutboxRecord`. */
export const OUTBOX_RECORD_CELL = 'record';

export function createPrimaryStore(): Store {
  return createStore();
}

export function createOutboxStore(): Store {
  return createStore();
}
