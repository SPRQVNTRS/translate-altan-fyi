/**
 * COPIED, NOT SHARED. Source: openplate/app/lib/sync/engine/merge/types.ts @ 68e893ac71d25ad7ff42280773ea0ec94f4f700e.
 * See .adr/0008-e2ee-sync-copied-not-extracted.md. Fixes belong upstream first,
 * then here. Do not let the two drift.
 */
/**
 * Entity-layer merge types (design spec D3). Deliberately generic over the
 * entity VALUE type — the merge layer never needs to know whether an entity is a
 * food log, a weigh-in, or a profile row (that's the OSS local-store's
 * concern); it only needs `(lamport, deviceId)` to order two candidates for
 * the same entity id.
 */

/** One entity's ordering stamp — bumped on local edit, reconciled to `max(seen)+1` on merge (D3). */
export interface LamportStamp {
  lamport: number;
  deviceId: string;
}

/** A merge candidate for one entity id: either a live value or a tombstone (deleted). */
export interface MergeCandidate<T> extends LamportStamp {
  entityId: string;
  /** `null` means this candidate is a tombstone — the entity was deleted at this `(lamport, deviceId)`. */
  value: T | null;
}

/** The tombstone shape as it appears in the wire payload's `syncMeta.tombstones` (D2). */
export interface Tombstone extends LamportStamp {
  entityId: string;
  entityType: string;
}

/** `syncMeta`'s shape inside the decrypted payload (D2) — perEntity ordering stamps plus retained tombstones. */
export interface SyncMeta {
  perEntity: Record<string, LamportStamp>;
  tombstones: Tombstone[];
}
