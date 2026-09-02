/**
 * COPIED, NOT SHARED. Source: openplate/app/lib/sync/engine/merge/merge-entities.ts @ 68e893ac71d25ad7ff42280773ea0ec94f4f700e.
 * See .adr/0008-e2ee-sync-copied-not-extracted.md. Fixes belong upstream first,
 * then here. Do not let the two drift.
 */
/**
 * Pure entity-layer merge logic (design spec D3). Device wall-clock is
 * explicitly ruled out as the ordering authority (it drifts and is trivially
 * wrong across devices) — every decision here is `(lamport, deviceId)` only.
 *
 * Accepted v1 trade-off, stated plainly in D3: whole-record per-entity LWW
 * means a concurrent offline edit to the SAME entity on two devices silently
 * loses the older write. No field-level merge, no conflict UI. Accepted for
 * v1 (single-user multi-device, low collision probability).
 */
import type { LamportStamp, MergeCandidate, Tombstone } from './types';

/** A per-entity candidate map keyed by entity id — the merge layer's own contract for "one side of a merge". */
export interface MergeCandidateMap<T> {
  [entityId: string]: MergeCandidate<T>;
}

/**
 * Compares two candidates for the SAME entity id and returns the winner:
 * higher `lamport` wins; a tie breaks on `deviceId` (lexicographic — any
 * total order works, it only needs to be the SAME order on every device).
 */
export function pickMergeWinner<T>(a: MergeCandidate<T>, b: MergeCandidate<T>): MergeCandidate<T> {
  if (a.lamport !== b.lamport) return a.lamport > b.lamport ? a : b;
  return a.deviceId > b.deviceId ? a : b;
}

/**
 * Merges two per-entity candidate maps (e.g. this device's pending local
 * state vs. the just-pulled remote state) into one, applying
 * {@link pickMergeWinner} per entity id. An entity present on only one side
 * passes through unchanged.
 */
export function mergeEntityMaps<T>(
  local: Readonly<MergeCandidateMap<T>>,
  remote: Readonly<MergeCandidateMap<T>>,
): MergeCandidateMap<T> {
  const merged: MergeCandidateMap<T> = { ...local };
  for (const [entityId, remoteCandidate] of Object.entries(remote)) {
    const localCandidate = merged[entityId];
    merged[entityId] = localCandidate ? pickMergeWinner(localCandidate, remoteCandidate) : remoteCandidate;
  }
  return merged;
}

/**
 * The next Lamport value for a local edit: `max(seen) + 1` (D3). `seen`
 * should include every lamport value this device currently knows about for
 * the entity being edited (typically just its own current stamp, but a
 * freshly-merged entity might have a HIGHER stamp than this device has ever
 * issued — reconciling to `max(seen)+1` on merge, not just `own+1`, is what
 * keeps this a genuine Lamport clock rather than a per-device counter).
 */
export function nextLamport(seen: readonly number[]): number {
  return Math.max(0, ...seen) + 1;
}

/** Builds a `MergeCandidate` for a live (non-deleted) entity value. */
export function liveCandidate<T>(entityId: string, stamp: LamportStamp, value: T): MergeCandidate<T> {
  return { entityId, lamport: stamp.lamport, deviceId: stamp.deviceId, value };
}

/** Builds a `MergeCandidate` for a tombstone (deleted entity). */
export function tombstoneCandidate<T>(tombstone: Tombstone): MergeCandidate<T> {
  return { entityId: tombstone.entityId, lamport: tombstone.lamport, deviceId: tombstone.deviceId, value: null };
}

/**
 * Tombstone compaction (D3): a tombstone can be safely dropped once it is
 * BOTH older than `retentionDays` AND the caller has confirmed at least one
 * full sync cycle has elapsed since it was created (that confirmation —
 * "has every device that might not have seen this tombstone yet had a
 * chance to pull it" — is a policy decision the caller makes; this function
 * only applies the age half of the rule, which is the part that's pure and
 * testable). A device offline longer than `retentionDays` treats the server
 * copy as authoritative on rejoin (D3) — it does not need its own stale
 * tombstones to still be present to converge correctly.
 *
 * @param tombstones - candidate tombstones to filter.
 * @param nowMs - the current time (injected — never `Date.now()` internally, so this stays pure/testable).
 * @param createdAtMs - per-tombstone creation time, since `Tombstone` itself carries no timestamp (only a Lamport stamp).
 * @param retentionDays - the age threshold; defaults to D3's 90 days.
 */
export function selectCompactableTombstones({
  tombstones,
  nowMs,
  createdAtMs,
  retentionDays = 90,
}: {
  tombstones: readonly Tombstone[];
  nowMs: number;
  createdAtMs: (tombstone: Tombstone) => number;
  retentionDays?: number;
}): Tombstone[] {
  const maxAgeMs = retentionDays * 24 * 60 * 60 * 1000;
  return tombstones.filter((tombstone) => nowMs - createdAtMs(tombstone) > maxAgeMs);
}
