/**
 * COPIED, NOT SHARED. Source: openplate/app/lib/sync/snapshot-sync.ts @ 68e893ac71d25ad7ff42280773ea0ec94f4f700e.
 * See .adr/0008-e2ee-sync-copied-not-extracted.md. Fixes belong upstream first,
 * then here. Do not let the two drift.
 */
/**
 * The PURE core of sync: turning a local-store snapshot into the wire meta,
 * and merging two payloads into one. No fetch, no crypto, no IndexedDB, no
 * clock — everything here is a function of its arguments, which is what makes
 * convergence testable without a server (`functional-core`).
 *
 * ── Where the Lamport stamps come from, and how that differs upstream ──────
 *
 * Upstream, the app's write paths know nothing about sync, so each cycle DIFFS
 * the current snapshot against a persisted BASELINE of per-entity content
 * hashes and derives a stamp from what changed. Here every write helper in
 * `primary-store.ts` sets `(lamport, deviceId)` at the moment of the edit, so
 * the stamp is already on the row. This module therefore READS stamps where
 * the source DERIVES them: there is no hasher, no baseline, and no
 * `stampSnapshot`.
 *
 * The consequence is that the ROW is the ordering authority on both sides of a
 * merge, and `syncMeta.perEntity` is a faithful projection of it rather than a
 * separate truth. See {@link toWireMeta}.
 *
 * ── What is deliberately NOT here ─────────────────────────────────────────
 *
 * Conflict resolution is whole-record last-writer-wins per entity, ordered by
 * `(lamport, deviceId)` — `PROTOCOL.md` section 3.3's accepted v1 trade-off.
 * Two devices editing the SAME entry offline means the lower stamp is dropped
 * silently. No field-level merge, no conflict UI. Wall-clock time is never an
 * ordering authority: it drifts, and across devices it is routinely wrong.
 * `SyncStamp.updatedAt` exists for the UI and for local housekeeping, and is
 * never read by anything in this file.
 */
import { mergeEntityMaps, type MergeCandidateMap } from '#app/lib/sync/engine/merge/merge-entities';
import type { Tombstone } from '#app/lib/sync/engine/merge/types';
import type { SyncMetaPayload } from '#app/lib/sync/engine/envelope/types';
import type { SyncedSnapshot } from '#app/lib/local-store';
import type { LocalList, LocalListItem, LocalNote, SyncStamp } from '#app/lib/local-store';

/** The entity-type tags that appear in tombstones and in namespaced entity keys. */
export const SYNC_ENTITY_TYPES = {
  list: 'list',
  listItem: 'listItem',
  note: 'note',
} as const;

/** A stamped payload, ready to encrypt (or just merged out of two others). */
export interface StampedSnapshot {
  snapshot: SyncedSnapshot;
  meta: SyncMetaPayload;
}

/** Namespaced entity key: `list:abc`. Namespacing prevents a list and a note that share an id from colliding. */
export function entityKey(entityType: string, entityId: string): string {
  return `${entityType}:${entityId}`;
}

/** The three record kinds the blob carries. Every one of them extends `SyncStamp`. */
type SyncEntityValue = LocalList | LocalListItem | LocalNote;

interface FlatEntity {
  key: string;
  entityType: string;
  entityId: string;
  value: SyncEntityValue;
}

/** Flattens a snapshot into one addressable list, so the merge is written once rather than three times. */
function flattenSnapshot(snapshot: SyncedSnapshot): FlatEntity[] {
  return [
    ...snapshot.lists.map((list) => toFlat(SYNC_ENTITY_TYPES.list, list.id, list)),
    ...snapshot.listItems.map((item) => toFlat(SYNC_ENTITY_TYPES.listItem, item.id, item)),
    ...snapshot.notes.map((note) => toFlat(SYNC_ENTITY_TYPES.note, note.id, note)),
  ];
}

function toFlat(entityType: string, entityId: string, value: SyncEntityValue): FlatEntity {
  return { key: entityKey(entityType, entityId), entityType, entityId, value };
}

// ---------------------------------------------------------------------------
// The wire meta
// ---------------------------------------------------------------------------

/**
 * Builds the wire meta from the rows themselves.
 *
 * Upstream this was `stampSnapshot`, which computed a stamp by diffing content
 * hashes against a persisted baseline. Here the stamp already exists: every
 * write helper in `primary-store.ts` sets `(lamport, deviceId)` at the moment
 * of the edit. So this function reads rather than derives, and the wire shape
 * `PROTOCOL.md` section 3.2 specifies is unchanged: a live row contributes a
 * `perEntity` entry, a `deleted` row contributes a tombstone.
 *
 * The stamps are ALSO carried on the rows inside `snapshot`, which is
 * redundant on the wire and deliberate: `snapshot` is protocol-opaque, and
 * `applyMergedSnapshot` needs the stamp to survive onto the device so the next
 * cycle does not have to reconstruct it.
 */
export function toWireMeta(snapshot: SyncedSnapshot): SyncMetaPayload {
  const perEntity: SyncMetaPayload['perEntity'] = {};
  const tombstones: Tombstone[] = [];
  for (const entity of flattenSnapshot(snapshot)) {
    const stamp = { lamport: entity.value.lamport, deviceId: entity.value.deviceId };
    if (entity.value.deleted) {
      tombstones.push({ entityId: entity.entityId, entityType: entity.entityType, ...stamp });
      continue;
    }
    perEntity[entity.key] = stamp;
  }
  return { perEntity, tombstones };
}

// ---------------------------------------------------------------------------
// Merging: two stamped payloads -> one
// ---------------------------------------------------------------------------

/**
 * One side of a merge, as the ordering rule sees it: `value: null` for a
 * candidate that says "this entity is gone", the row for one that says it is
 * here.
 *
 * BOTH a `deleted` ROW and a `meta` TOMBSTONE produce a null candidate. They
 * are the same statement told twice — a delete travels as a tombstoned row,
 * and `toWireMeta` projects that row into `syncMeta.tombstones` — so the merge
 * must not be able to reach a different conclusion depending on which one it
 * read.
 */
function toCandidateMap(payload: StampedSnapshot): MergeCandidateMap<FlatEntity> {
  const candidates: MergeCandidateMap<FlatEntity> = {};
  for (const entity of flattenSnapshot(payload.snapshot)) {
    candidates[entity.key] = {
      entityId: entity.key,
      lamport: entity.value.lamport,
      deviceId: entity.value.deviceId,
      value: entity.value.deleted ? null : entity,
    };
  }
  for (const tombstone of payload.meta.tombstones) {
    const key = entityKey(tombstone.entityType, tombstone.entityId);
    const existing = candidates[key];
    // A payload should never carry both, but if it does, the higher stamp is
    // the honest reading of what that device last knew.
    if (existing !== undefined && existing.lamport >= tombstone.lamport) continue;
    candidates[key] = { entityId: key, lamport: tombstone.lamport, deviceId: tombstone.deviceId, value: null };
  }
  return candidates;
}

/**
 * Every ROW either side holds, live or tombstoned, under the same
 * `(lamport, deviceId)` rule.
 *
 * It exists so a tombstone winner can be rebuilt as a real row rather than as
 * meta alone: the row body has to come from somewhere, and picking it with the
 * merge's own ordering rule is what keeps two devices choosing the same one.
 */
function toRowMap(payload: StampedSnapshot): MergeCandidateMap<FlatEntity> {
  const rows: MergeCandidateMap<FlatEntity> = {};
  for (const entity of flattenSnapshot(payload.snapshot)) {
    rows[entity.key] = {
      entityId: entity.key,
      lamport: entity.value.lamport,
      deviceId: entity.value.deviceId,
      value: entity,
    };
  }
  return rows;
}

/** The three collections a merge rebuilds, passed around as one so the append helper stays a single function. */
interface MergedCollections {
  lists: LocalList[];
  listItems: LocalListItem[];
  notes: LocalNote[];
}

/** The stamp fields a merge winner imposes on the row it rebuilds. `updatedAt` is NOT among them — it is never an ordering authority. */
type WinningStamp = Pick<SyncStamp, 'lamport' | 'deviceId' | 'deleted'>;

/**
 * Appends one merged row to its collection, with the winning stamp applied.
 *
 * `flattenSnapshot` is the only producer of a `FlatEntity`, and each of its
 * `toFlat` calls pairs an `entityType` tag with a value taken from the
 * matching snapshot collection. The tag therefore decides which member of the
 * union `entity.value` is, which is what each assertion below reads.
 */
function appendEntity({ entity, stamp, into }: { entity: FlatEntity; stamp: WinningStamp; into: MergedCollections }): void {
  if (entity.entityType === SYNC_ENTITY_TYPES.list) {
    // SAFETY: the `list` tag is only ever attached to a `LocalList`.
    into.lists.push({ ...(entity.value as LocalList), ...stamp });
    return;
  }
  if (entity.entityType === SYNC_ENTITY_TYPES.listItem) {
    // SAFETY: the `listItem` tag is only ever attached to a `LocalListItem`.
    into.listItems.push({ ...(entity.value as LocalListItem), ...stamp });
    return;
  }
  // SAFETY: the `note` tag is the only remaining member of `SYNC_ENTITY_TYPES`,
  // and it is only ever attached to a `LocalNote`.
  into.notes.push({ ...(entity.value as LocalNote), ...stamp });
}

/**
 * Merges the local payload with a just-pulled remote one.
 *
 * Deterministic and symmetric: both devices running this over the same pair of
 * inputs land on byte-identical output, which is what makes "push, lose the
 * CAS, pull, merge, re-push" terminate instead of ping-ponging. The sorted key
 * iteration below is half of that guarantee; picking the tombstone body with
 * the same ordering rule as the stamp is the other half.
 *
 * A TOMBSTONE WINNER IS REBUILT AS A `deleted: true` ROW as well as a meta
 * tombstone. A delete travels as a row here, so a merged snapshot that carried
 * only the meta half would be written onto the device with the row gone — and
 * the next cycle would push the entity back as if it had never been deleted.
 */
export function mergeSnapshots({ local, remote }: { local: StampedSnapshot; remote: StampedSnapshot }): StampedSnapshot {
  const merged = mergeEntityMaps(toCandidateMap(local), toCandidateMap(remote));
  const rows = mergeEntityMaps(toRowMap(local), toRowMap(remote));

  const collections: MergedCollections = { lists: [], listItems: [], notes: [] };
  const perEntity: SyncMetaPayload['perEntity'] = {};
  const tombstones: Tombstone[] = [];

  for (const key of Object.keys(merged).toSorted()) {
    const candidate = merged[key];
    if (candidate === undefined) continue;
    const stamp = { lamport: candidate.lamport, deviceId: candidate.deviceId };

    if (candidate.value === null) {
      const [entityType, ...idParts] = key.split(':');
      tombstones.push({ entityId: idParts.join(':'), entityType: entityType ?? '', ...stamp });
      const body = rows[key]?.value;
      // A tombstone with no row anywhere on either side is a delete whose row
      // has already been compacted away. It stays meta-only: inventing a row
      // to declare it gone would resurrect the entity as a shape.
      if (body !== undefined && body !== null) appendEntity({ entity: body, stamp: { ...stamp, deleted: true }, into: collections });
      continue;
    }

    perEntity[key] = stamp;
    appendEntity({ entity: candidate.value, stamp: { ...stamp, deleted: false }, into: collections });
  }

  return { snapshot: collections, meta: { perEntity, tombstones } };
}

/**
 * Whether two payloads are the same in every way that matters on the wire.
 *
 * The orchestrator uses this to SKIP a push when the merge contributed
 * nothing. Without it, every boot of every device would write a new blob
 * version — burning the 5-version retention window, and turning "open the app"
 * into a write.
 */
export function payloadsEqual(a: StampedSnapshot, b: StampedSnapshot): boolean {
  return stableStringify(canonicalize(a)) === stableStringify(canonicalize(b));
}

/** Stable order for an id-bearing collection, so two devices serialize the same set identically. */
function byId<T extends { id: string }>(items: T[]): T[] {
  return items.toSorted((x, y) => (x.id < y.id ? -1 : 1));
}

function canonicalize(payload: StampedSnapshot) {
  return {
    snapshot: {
      lists: byId(payload.snapshot.lists),
      listItems: byId(payload.snapshot.listItems),
      notes: byId(payload.snapshot.notes),
    },
    meta: {
      perEntity: payload.meta.perEntity,
      tombstones: payload.meta.tombstones.toSorted((x, y) =>
        entityKey(x.entityType, x.entityId) < entityKey(y.entityType, y.entityId) ? -1 : 1,
      ),
    },
  };
}

/**
 * Deterministic JSON with sorted object keys.
 *
 * `JSON.stringify` preserves insertion order, so two structurally identical
 * entities written by different code paths can serialize differently — which
 * would read as "changed" on every single sync and re-push the whole store
 * forever. Sorting the keys removes that.
 */
export function stableStringify<T>(value: T): string {
  if (!(value instanceof Object)) return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.entries(value)
    .filter(([, entryValue]) => entryValue !== undefined)
    .toSorted(([a], [b]) =>
      a < b ? -1
      : a > b ? 1
      : 0,
    );
  return `{${entries.map(([key, entryValue]) => `${JSON.stringify(key)}:${stableStringify(entryValue)}`).join(',')}}`;
}
