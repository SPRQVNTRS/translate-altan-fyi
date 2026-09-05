/**
 * The device-only search log: what was looked up, when, and which headword the
 * lookup landed on.
 *
 * This module has NO upstream counterpart, so it carries no provenance header.
 * It is also the one table in the local layer that is not synced. It carries no
 * `SyncStamp`, it is HARD-deleted rather than tombstoned, and it never enters
 * the encrypted blob — the reasoning is in `app/lib/local-store/BLOB-CONTENTS.md`, and
 * the consequence here is that there is nothing to converge with, so a deleted
 * entry needs no marker to say so.
 *
 * ONE ROW PER SEARCH, NOT ONE ROW PER LOOKUP. `recordSearch` is an UPSERT on
 * `(query, from, to)`, so searching the same word five times leaves one row
 * carrying the latest instant rather than five rows saying the same thing.
 * `headwordId` is deliberately outside that key: the same typed word can land
 * on a different top hit as the dictionary grows, and a reader who types the
 * same thing twice has run the same search either way.
 *
 * THE ROW'S `id` SURVIVES AN UPDATE, and that is a promise rather than an
 * implementation detail: the id is what a screen keys a row on, so minting a
 * new one on every repeat would replace the row a reader was looking at.
 *
 * THE CAP IS ENFORCED ON EVERY WRITE, not on a schedule. A schedule is a second
 * thing that has to run, and a device whose scheduler never fires is exactly
 * the device holding the log nobody meant to keep. Writing is the only moment
 * the log can grow, so it is the only moment the cap has to be applied.
 */
import type { Store } from 'tinybase';
import { z } from 'zod';
import { HISTORY_TABLE, PRIMARY_ENTITY_CELL } from './store';
import { HISTORY_CAP } from './schema';
import type { LocalHistoryEntry } from './schema';
import { getPrimaryStore } from './persist';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** The entry cell as it comes back off the store — a TinyBase cell, not yet JSON text. */
const entryCellSchema = z.string();

interface StoreOption {
  store?: Store;
}

async function resolveStore(store: Store | undefined): Promise<Store> {
  return store ?? (await getPrimaryStore());
}

/** Parses one row's entry cell, or null when absent/corrupt (never throws). */
function readEntry(store: Store, id: string): LocalHistoryEntry | null {
  const raw = entryCellSchema.safeParse(store.getCell(HISTORY_TABLE, id, PRIMARY_ENTITY_CELL));
  if (!raw.success) return null;
  try {
    // SAFETY: this cell is written only by `writeEntries` below, which stores
    // `JSON.stringify(LocalHistoryEntry)` — the parse of a value this module
    // alone produces. A malformed/foreign value throws and is caught.
    return JSON.parse(raw.data) as LocalHistoryEntry;
  } catch {
    return null;
  }
}

function readEntries(store: Store): LocalHistoryEntry[] {
  return store
    .getRowIds(HISTORY_TABLE)
    .map((id) => readEntry(store, id))
    .filter((entry): entry is LocalHistoryEntry => entry !== null);
}

/** Replaces the whole table with exactly `entries`, in one transaction so the rewrite costs one autosave. */
function writeEntries(store: Store, entries: readonly LocalHistoryEntry[]): void {
  store.transaction(() => {
    store.delTable(HISTORY_TABLE);
    for (const entry of entries) {
      store.setRow(HISTORY_TABLE, entry.id, { [PRIMARY_ENTITY_CELL]: JSON.stringify(entry) });
    }
  });
}

/**
 * The entries that survive the cap, newest first.
 *
 * BOTH halves are applied, and the age half first: a device that searched once
 * a year for ten years is under the count cap and still holding a decade of
 * queries, and a device that searched 900 times this morning is inside the age
 * window and still over the count.
 *
 * Pure, and exported, because this is the whole policy — a test that drives it
 * directly is testing the cap itself rather than a store's behaviour around it.
 */
export function pruneHistory(entries: readonly LocalHistoryEntry[], nowMs: number): LocalHistoryEntry[] {
  const oldestKept = nowMs - HISTORY_CAP.days * MS_PER_DAY;
  return entries
    .filter((entry) => entry.at >= oldestKept)
    .toSorted((a, b) => b.at - a.at || b.id.localeCompare(a.id))
    .slice(0, HISTORY_CAP.count);
}

/** What a caller supplies for one recorded search — the id and the instant are this module's to assign. */
export interface RecordSearchInput {
  query: string;
  from: string;
  to: string;
  headwordId: string | null;
  /** The answer this search got, or `null` when it is being recorded before one arrived. */
  translation: string | null;
}

/**
 * What makes two recorded searches the same search: the words typed and the two
 * languages. Nothing else, and the exclusion of `headwordId` is the point: see
 * this module's header.
 */
function searchIdentity({ query, from, to }: { query: string; from: string; to: string }): string {
  return [query, from, to].join('\u0000');
}

/**
 * Records one search, then rewrites the table to exactly what survives the cap.
 *
 * AN UPSERT. A search already in the log keeps its `id` and takes the new
 * instant, headword and answer, so a repeat moves the row to the top instead of
 * adding a second copy of it beside the first. `listHistory` and `pruneHistory`
 * both order on `at`, so moving the instant IS moving the row, and no ordering
 * code knows about any of this.
 *
 * AN ANSWER IS NEVER UNWRITTEN BY A LATER `null`. The recorder calls this once
 * as soon as the search is on screen and again when the pane has words, and a
 * repeat of the same search starts at `null` again while its own run warms up.
 * Taking that `null` literally would blank an answer the reader can still see.
 *
 * The write itself is a full rewrite of the table, and a HARD one: there is no
 * tombstone anywhere in this module, because there is nothing to converge with.
 */
export async function recordSearch(
  input: RecordSearchInput,
  options: { store?: Store; now?: () => number } = {},
): Promise<void> {
  const store = await resolveStore(options.store);
  const now = options.now ?? Date.now;
  const at = now();
  const identity = searchIdentity(input);
  const entries = readEntries(store);
  const existing = entries.find((entry) => searchIdentity(entry) === identity);
  const entry: LocalHistoryEntry = {
    ...input,
    id: existing?.id ?? crypto.randomUUID(),
    translation: input.translation ?? existing?.translation ?? null,
    at,
  };
  const others = entries.filter((other) => other.id !== entry.id);
  writeEntries(store, pruneHistory([...others, entry], at));
}

/** Every recorded search still on this device, newest first. */
export async function listHistory({ store }: StoreOption = {}): Promise<LocalHistoryEntry[]> {
  return readEntries(await resolveStore(store)).toSorted((a, b) => b.at - a.at || b.id.localeCompare(a.id));
}

/** Drops the whole search log. Hard, immediate and device-local — the "clear" a person expects to mean cleared. */
export async function clearHistory({ store }: StoreOption = {}): Promise<void> {
  (await resolveStore(store)).delTable(HISTORY_TABLE);
}

/**
 * Merges entries from a backup file into the log, by id, then re-applies the
 * cap. The counterpart of the export in `backup.ts`, and it exists because the
 * alternative is worse than it looks: an export that carries the search log and
 * a restore that ignores it is a backup that shows a person their own searches
 * in the file and then does not give them back.
 *
 * The merge is by id and the result is re-pruned, so restoring the same file
 * twice is idempotent and a restore can never push the log over its cap.
 */
export async function importHistoryEntries(
  entries: readonly LocalHistoryEntry[],
  options: { store?: Store; now?: () => number } = {},
): Promise<void> {
  if (entries.length === 0) return;
  const store = await resolveStore(options.store);
  const now = options.now ?? Date.now;
  const byId = new Map(readEntries(store).map((entry) => [entry.id, entry]));
  for (const entry of entries) byId.set(entry.id, entry);
  writeEntries(store, pruneHistory([...byId.values()], now()));
}
