/**
 * The projection of a device snapshot onto the collections that ride the
 * encrypted blob.
 *
 * This module has no upstream counterpart, so it carries no provenance header.
 *
 * WHAT THE BLOB CARRIES, AND WHAT IT DELIBERATELY LEAVES BEHIND, IS STATED IN
 * `app/lib/local-store/BLOB-CONTENTS.md`. Read the reasoning there. It is not repeated
 * here, on purpose: two statements of one policy are two things to keep in step,
 * and the document is the one that is normative.
 *
 * `app/lib/sync/engine/envelope/` frames these rows for the wire. It says nothing about
 * this shape, because the server cannot read it.
 */
import { z } from 'zod';
import type { LocalList, LocalListItem, LocalNote, LocalReviewState } from './schema';

/** The four collections that ride the encrypted blob. See app/lib/local-store/BLOB-CONTENTS.md for what is in it and what is deliberately not. */
export interface SyncedSnapshot {
  lists: LocalList[];
  listItems: LocalListItem[];
  notes: LocalNote[];
  reviewState: LocalReviewState[];
}

/**
 * Projects a snapshot onto the collections the blob carries, and is the ONE
 * place that names them.
 *
 * THE PARAMETER IS THE NARROW SHAPE ON PURPOSE, AND THAT IS WHAT MAKES ONE
 * PROJECTION SERVE TWO CALLERS. A full `LocalStoreSnapshot` is assignable to
 * it, and so is the sync bridge's read of the same four collections with
 * tombstones included, so the device export path and the live push path go
 * through this function rather than through two lists of collection names that
 * can drift. `app/lib/sync/local-store-bridge.ts`'s `readLocalSnapshot` is the
 * caller on the live path; it assembles the reads and hands them here, so what
 * leaves a device is whatever this returns and nothing else.
 *
 * The collections the blob carries, and the one it deliberately leaves behind,
 * are stated in `app/lib/local-store/BLOB-CONTENTS.md`.
 */
export function toSyncedSnapshot(snapshot: SyncedSnapshot): SyncedSnapshot {
  return {
    lists: snapshot.lists,
    listItems: snapshot.listItems,
    notes: snapshot.notes,
    reviewState: snapshot.reviewState,
  };
}

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

/**
 * What the flashcard loop recorded about one saved word. The `id` is the list
 * entry's own id.
 *
 * The counters are `nonnegative`, not `positive`: a word answered once is a
 * row with one count at zero, and rejecting that would refuse the ordinary
 * case. There is no scheduling field to validate, by design.
 */
const reviewStateSchema = z.object({
  ...syncStampFields,
  id: z.string(),
  gotItCount: z.number().int().nonnegative(),
  stillLearningCount: z.number().int().nonnegative(),
  lastReviewedAt: z.number().int(),
});

/**
 * A `SyncedSnapshot` arriving from a peer, for `parseRemoteSnapshot` to
 * validate against.
 *
 * A PULLED BLOB IS STILL UNTRUSTED INPUT. The session proves it is what some
 * device of this account wrote — but that device may have run an older or a
 * newer build, and a shape mismatch must fail here rather than surface as an
 * undefined field on a screen. Each collection defaults to
 * empty, so a blob written before a collection existed is read as "that device
 * had none", which is true, rather than rejected outright.
 */
export const syncedSnapshotSchema = z.object({
  lists: z.array(listSchema).default([]),
  listItems: z.array(listItemSchema).default([]),
  notes: z.array(noteSchema).default([]),
  reviewState: z.array(reviewStateSchema).default([]),
});
