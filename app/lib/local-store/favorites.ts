/**
 * Favourites: the words a reader kept with one tap on the answer they were
 * given.
 *
 * This module has no upstream counterpart, so it carries no provenance header.
 * It is a SYNCED collection, so it behaves like lists and notes and not like
 * the search log: every row carries a {@link SyncStamp}, a removal is a
 * tombstone rather than a hard delete, and the rows ride the blob
 * (`app/lib/local-store/BLOB-CONTENTS.md`).
 *
 * WHY THIS IS ITS OWN MODULE RATHER THAN FOUR MORE FUNCTIONS IN
 * `primary-store.ts`. Everything there is a plain upsert keyed by an id the
 * caller minted, and a favourite is not: it is keyed by what it is ABOUT, so
 * the id is derived here and the caller never supplies one. Putting a second
 * keying rule in among four identical ones is how the next reader comes to
 * believe there is only one.
 *
 * THE KEY IS `(headwordId, senseId, to)`, AND EACH THIRD OF IT IS LOAD-BEARING.
 *   - `headwordId` is the word.
 *   - `senseId` is the meaning, when the save happened somewhere a meaning had
 *     already been chosen. It is null for a save from the answer card, where
 *     there is no meaning to have chosen, and null is a value of the key rather
 *     than a hole in it.
 *   - `to` is the target language. The same word kept in Turkish and in Spanish
 *     is two favourites, because the thing being kept is the ANSWER and the two
 *     answers are different words.
 *
 * THE ID IS DERIVED FROM THAT KEY, NOT MINTED. Two consequences, both wanted.
 * Saving the same word twice writes the same row twice instead of leaving two
 * rows that render identically and have to be removed one at a time. And two
 * DEVICES that save the same word produce the same id, so the merge sees one
 * entity with two stamps and settles it, rather than converging on a duplicate
 * pair nobody can tell apart. A minted UUID would give both of those away for
 * nothing: there is no second favourite of one word for a random id to
 * distinguish.
 */
import type { Store } from 'tinybase';
import { z } from 'zod';
import { FAVORITES_TABLE, PRIMARY_ENTITY_CELL, SCHEMA_VERSION_VALUE } from './store';
import { SCHEMA_VERSION } from './schema';
import type { LocalFavorite, SyncStamp } from './schema';
import { getPrimaryStore, requestPersistentStorage } from './persist';
import { nextLamport, resolveDeviceId } from './primary-store';

/** A favourite as a caller supplies it: what it is about, with no id and no stamp. */
export type LocalFavoriteInput = Omit<LocalFavorite, keyof SyncStamp | 'id'>;

/** The entity cell as it comes back off the store — a TinyBase cell, not yet JSON text. */
const entityCellSchema = z.string();

interface StoreOption {
  store?: Store;
}

/** The write options every mutation takes. `now` and `deviceId` are injectable so a test can assert an exact stamp. */
interface WriteOption extends StoreOption {
  now?: () => number;
  deviceId?: string;
}

async function resolveStore(store: Store | undefined): Promise<Store> {
  return store ?? (await getPrimaryStore());
}

/**
 * The id of the favourite that keeps this word, in this meaning, in this
 * language.
 *
 * The separator can never be ambiguous here: a headword id and a sense id are
 * both UUIDs and a language code is two letters, so none of the three parts can
 * contain the separator and no two distinct keys can collapse onto one string.
 * A null `senseId` becomes the empty segment, which no real UUID can be, so
 * "no meaning was chosen" is a key of its own rather than a collision with one.
 *
 * Pure and exported, because a caller that wants to ask whether one particular
 * word is saved should ask by key rather than by scanning a list.
 */
export function favoriteId({ headwordId, senseId, to }: { headwordId: string; senseId: string | null; to: string }): string {
  return `${headwordId}::${senseId ?? ''}::${to}`;
}

/** Parses one row's entity cell, or null when absent or corrupt (never throws). */
function readFavorite(store: Store, id: string): LocalFavorite | null {
  if (!store.hasRow(FAVORITES_TABLE, id)) return null;
  const raw = entityCellSchema.safeParse(store.getCell(FAVORITES_TABLE, id, PRIMARY_ENTITY_CELL));
  if (!raw.success) return null;
  try {
    // SAFETY: this cell is written only by `writeFavorite` below, which stores
    // `JSON.stringify(LocalFavorite)`. A malformed or foreign value throws and
    // is caught.
    return JSON.parse(raw.data) as LocalFavorite;
  } catch {
    return null;
  }
}

/** Every favourite row, tombstones included, corrupt rows skipped. Unordered — callers sort. */
function readFavorites(store: Store): LocalFavorite[] {
  return store
    .getRowIds(FAVORITES_TABLE)
    .map((id) => readFavorite(store, id))
    .filter((favorite): favorite is LocalFavorite => favorite !== null);
}

/**
 * Writes one row and requests persistent storage, exactly as `primary-store.ts`
 * does: the schema-version value has to stay honest whichever collection was
 * written last, and the first write on a device is the durability trigger.
 */
function writeFavorite(store: Store, favorite: LocalFavorite): void {
  requestPersistentStorage();
  store.setValue(SCHEMA_VERSION_VALUE, SCHEMA_VERSION);
  store.setRow(FAVORITES_TABLE, favorite.id, { [PRIMARY_ENTITY_CELL]: JSON.stringify(favorite) });
}

/** Builds the stamp for one write, bumping this row's own lamport and marking it live or dead. */
async function nextStamp(store: Store, id: string, deleted: boolean, options: WriteOption): Promise<SyncStamp> {
  const now = options.now ?? Date.now;
  return {
    lamport: nextLamport([readFavorite(store, id)?.lamport ?? 0]),
    deviceId: options.deviceId ?? (await resolveDeviceId({ store })),
    updatedAt: now(),
    deleted,
  };
}

/** The rows a reader may see: a tombstone is still a row, and must never reach a screen. */
function isLive(favorite: LocalFavorite): boolean {
  return !favorite.deleted;
}

/** Stable order, so a backup and a blob serialize the same set identically. */
function byId(a: LocalFavorite, b: LocalFavorite): number {
  return a.id.localeCompare(b.id);
}

/**
 * Saves one word, or re-asserts one already saved.
 *
 * IDEMPOTENT BY THE KEY, NOT BY A LOOKUP. The id is derived, so a second save
 * of the same word overwrites the same row. The lamport still bumps, and that
 * is deliberate: re-tapping a star after the word was removed on another device
 * has to outrank that tombstone, or the removal would win and the reader's save
 * would silently do nothing.
 */
export async function putFavorite(input: LocalFavoriteInput, options: WriteOption = {}): Promise<LocalFavorite> {
  const store = await resolveStore(options.store);
  const id = favoriteId(input);
  const stamped: LocalFavorite = { ...input, id, ...(await nextStamp(store, id, false, options)) };
  writeFavorite(store, stamped);
  return stamped;
}

/**
 * Removes one favourite as a TOMBSTONE, never as a hard delete.
 *
 * The row stays with `deleted: true` and a bumped lamport, so the removal can
 * be pushed and can beat a peer still holding the live row. Hard-deleting would
 * let that peer's copy put the word back on the next pull, and the reader would
 * watch a favourite they removed reappear.
 *
 * A word that was never saved is left alone: there is nothing to tombstone, and
 * writing one would invent a favourite purely to declare it gone.
 */
export async function removeFavorite(id: string, options: WriteOption = {}): Promise<void> {
  const store = await resolveStore(options.store);
  const existing = readFavorite(store, id);
  if (!existing) return;
  writeFavorite(store, { ...existing, ...(await nextStamp(store, id, true, options)) });
}

/** Every saved word, id order. Tombstones are filtered out. */
export async function listFavorites({ store }: StoreOption = {}): Promise<LocalFavorite[]> {
  return readFavorites(await resolveStore(store))
    .filter(isLive)
    .toSorted(byId);
}

/** Every favourite INCLUDING tombstones — the sync path's read, which must carry the removals too. */
export async function listFavoritesIncludingDeleted({ store }: StoreOption = {}): Promise<LocalFavorite[]> {
  return readFavorites(await resolveStore(store)).toSorted(byId);
}

/** One live favourite by id, or null. A tombstoned row reads as absent, exactly as it does in `listFavorites`. */
export async function getFavorite(id: string, { store }: StoreOption = {}): Promise<LocalFavorite | null> {
  const favorite = readFavorite(await resolveStore(store), id);
  return favorite && isLive(favorite) ? favorite : null;
}

/**
 * Whether this word, in this meaning, in this language, is currently saved.
 *
 * It asks by KEY rather than scanning the collection, so the star button on an
 * answer card is one row lookup rather than a read of everything the reader has
 * ever kept.
 */
export async function isFavorite(
  key: { headwordId: string; senseId: string | null; to: string },
  { store }: StoreOption = {},
): Promise<boolean> {
  return (await getFavorite(favoriteId(key), { store })) !== null;
}
