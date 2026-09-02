/**
 * The conflict rule, PROTOCOL.md §3.3: higher `lamport` wins, ties break on
 * lexicographic `deviceId`, and a tombstone participates in the same
 * comparison as a live value.
 *
 * WHY THIS DRIVES `mergeSnapshots` AND NOT `pickMergeWinner`
 *   The pure comparator is four lines and trivially right. What actually
 *   protects a person's vocabulary lists is the whole path from two snapshots
 *   to one: flatten both sides into namespaced keys, fold the tombstones in,
 *   pick a winner per key, rebuild three collections AND the wire meta from
 *   the winners. Every defect that has ever cost data in this area lives in
 *   that path rather than in the comparison — a tombstone that wins the stamp
 *   but is dropped from the rebuilt rows, a merge whose output depends on
 *   which side was passed first. A test against the comparator alone cannot
 *   see any of it.
 *
 * THE DEFECTS THESE CASES CATCH
 *   - A tie-break that is not a TOTAL order (or is read in the wrong
 *     direction) makes two devices choose different winners for the same
 *     entity, so neither ever converges.
 *   - An asymmetric merge makes "push, lose the CAS, pull, merge, re-push"
 *     (PROTOCOL.md §5.1) ping-pong forever instead of terminating: each device
 *     keeps producing a payload the other disagrees with.
 *   - A tombstone winner rebuilt as meta ONLY, with no `deleted: true` row,
 *     is written onto the device with the row simply gone — and the next cycle
 *     pushes the entity back up as if it had never been deleted. A delete that
 *     resurrects is the loudest possible data defect and the cheapest to ship.
 *
 * No IndexedDB and no store: every input here is a plain object typed against
 * `SyncedSnapshot`.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { mergeSnapshots, stableStringify, toWireMeta, type StampedSnapshot } from '#app/lib/sync/snapshot-sync';
import type { LocalList, LocalListItem, LocalNote, SyncedSnapshot } from '#app/lib/local-store';

/** Wall clock is never an ordering authority (§3.3), so every fixture shares one value for it. */
const UPDATED_AT = 1_760_000_000_000;

interface ListFixture {
  id: string;
  name: string;
  lamport: number;
  deviceId: string;
  deleted?: boolean;
}

function list({ id, name, lamport, deviceId, deleted = false }: ListFixture): LocalList {
  return { id, name, languagePair: 'de-en', lamport, deviceId, updatedAt: UPDATED_AT, deleted };
}

function listItem({ id, lamport, deviceId }: { id: string; lamport: number; deviceId: string }): LocalListItem {
  return {
    id,
    listId: 'list-1',
    headwordId: `hw-${id}`,
    senseId: null,
    lemma: `lemma-${id}`,
    translationSnapshot: `translation-${id}`,
    note: '',
    lamport,
    deviceId,
    updatedAt: UPDATED_AT,
    deleted: false,
  };
}

function note({ id, lamport, deviceId }: { id: string; lamport: number; deviceId: string }): LocalNote {
  return { id, headwordId: `hw-${id}`, text: `text-${id}`, lamport, deviceId, updatedAt: UPDATED_AT, deleted: false };
}

function emptySnapshot(): SyncedSnapshot {
  return { lists: [], listItems: [], notes: [] };
}

/**
 * A payload as the orchestrator builds one: the rows, plus the wire meta
 * PROJECTED FROM THOSE ROWS by the real `toWireMeta`. Hand-writing the meta
 * would let a fixture state something the rows do not, which is exactly the
 * disagreement the production path cannot produce.
 */
function payload(snapshot: SyncedSnapshot): StampedSnapshot {
  return { snapshot, meta: toWireMeta(snapshot) };
}

/** The single merged list, failing loudly rather than returning `undefined` into an assertion. */
function onlyList(merged: StampedSnapshot): LocalList {
  assert.equal(merged.snapshot.lists.length, 1, 'the merge did not produce exactly one list');
  const [only] = merged.snapshot.lists;
  if (only === undefined) throw new Error('unreachable');
  return only;
}

/** Merges both ways round and asserts the two results are byte-identical, then returns the merge. */
function mergeBothDirections(a: StampedSnapshot, b: StampedSnapshot): StampedSnapshot {
  const forward = mergeSnapshots({ local: a, remote: b });
  const reverse = mergeSnapshots({ local: b, remote: a });
  assert.equal(
    stableStringify(forward),
    stableStringify(reverse),
    'the merge is not symmetric: swapping the two sides changed the result',
  );
  return forward;
}

describe('merge conflict resolution (PROTOCOL.md §3.3)', () => {
  it('resolves a two-device edit to the higher lamport, whichever side it arrives on', () => {
    const deviceA = payload({ ...emptySnapshot(), lists: [list({ id: 'l1', name: 'Reise', lamport: 2, deviceId: 'device-a' })] });
    const deviceB = payload({ ...emptySnapshot(), lists: [list({ id: 'l1', name: 'Urlaub', lamport: 3, deviceId: 'device-b' })] });

    const merged = mergeBothDirections(deviceA, deviceB);
    const winner = onlyList(merged);

    assert.equal(winner.name, 'Urlaub', 'the lower-lamport edit won');
    assert.equal(winner.lamport, 3);
    assert.equal(winner.deviceId, 'device-b');
    assert.deepEqual(merged.meta.perEntity['list:l1'], { lamport: 3, deviceId: 'device-b' });
  });

  it('breaks an equal-lamport tie on the lexicographically greater deviceId, in either direction', () => {
    // Equal lamports are the concurrent case: neither device saw the other's
    // edit. The tie-break only has to be the SAME total order everywhere, and
    // §3.3 fixes it as lexicographic on `deviceId`.
    const lower = payload({ ...emptySnapshot(), lists: [list({ id: 'l1', name: 'from-a', lamport: 4, deviceId: 'device-aaa' })] });
    const higher = payload({ ...emptySnapshot(), lists: [list({ id: 'l1', name: 'from-z', lamport: 4, deviceId: 'device-zzz' })] });

    const winner = onlyList(mergeBothDirections(lower, higher));

    assert.equal(winner.deviceId, 'device-zzz', 'the tie did not break on the greater deviceId');
    assert.equal(winner.name, 'from-z');
    assert.equal(winner.lamport, 4);
  });

  it('lets a higher-lamport tombstone beat a live row, and keeps the delete as a ROW', () => {
    const deleter = payload({
      ...emptySnapshot(),
      lists: [list({ id: 'l1', name: 'Reise', lamport: 5, deviceId: 'device-a', deleted: true })],
    });
    const stillLive = payload({ ...emptySnapshot(), lists: [list({ id: 'l1', name: 'Reise', lamport: 4, deviceId: 'device-b' })] });

    const merged = mergeBothDirections(deleter, stillLive);

    assert.deepEqual(
      merged.meta.tombstones,
      [{ entityId: 'l1', entityType: 'list', lamport: 5, deviceId: 'device-a' }],
      'the winning delete is missing from the wire meta',
    );
    assert.equal(merged.meta.perEntity['list:l1'], undefined, 'a deleted entity is still listed as live');

    // AND AS A ROW. A merged snapshot carrying only the meta half writes the
    // device with the row gone, and the next cycle pushes the entity back up.
    const row = onlyList(merged);
    assert.equal(row.deleted, true, 'the tombstone winner did not survive as a deleted row');
    assert.equal(row.lamport, 5);
    assert.equal(row.deviceId, 'device-a');
  });

  it('lets a higher-lamport live row beat a tombstone, so a re-added entry stays added', () => {
    // The entry someone deleted and then added back. If the tombstone won here
    // it would keep vanishing on every sync, once per device that still holds
    // the old delete.
    const readded = payload({ ...emptySnapshot(), lists: [list({ id: 'l1', name: 'Reise', lamport: 6, deviceId: 'device-b' })] });
    const oldDelete = payload({
      ...emptySnapshot(),
      lists: [list({ id: 'l1', name: 'Reise', lamport: 5, deviceId: 'device-a', deleted: true })],
    });

    const merged = mergeBothDirections(readded, oldDelete);
    const row = onlyList(merged);

    assert.equal(row.deleted, false, 'the older delete resurrected over a newer add');
    assert.equal(row.lamport, 6);
    assert.deepEqual(merged.meta.tombstones, [], 'the losing tombstone stayed in the wire meta');
    assert.deepEqual(merged.meta.perEntity['list:l1'], { lamport: 6, deviceId: 'device-b' });
  });

  it('is deterministic across all three collections at once', () => {
    // Lists, list items and notes share one merge implementation, so an
    // ordering defect can hide in whichever collection a single-collection
    // case does not cover.
    const deviceA: SyncedSnapshot = {
      lists: [
        list({ id: 'l2', name: 'a-l2', lamport: 1, deviceId: 'device-a' }),
        list({ id: 'l1', name: 'a-l1', lamport: 3, deviceId: 'device-a' }),
      ],
      listItems: [
        listItem({ id: 'i2', lamport: 2, deviceId: 'device-a' }),
        listItem({ id: 'i1', lamport: 2, deviceId: 'device-a' }),
      ],
      notes: [note({ id: 'n1', lamport: 4, deviceId: 'device-a' })],
    };
    const deviceB: SyncedSnapshot = {
      lists: [list({ id: 'l1', name: 'b-l1', lamport: 2, deviceId: 'device-b' })],
      listItems: [
        listItem({ id: 'i1', lamport: 2, deviceId: 'device-b' }),
        listItem({ id: 'i3', lamport: 9, deviceId: 'device-b' }),
      ],
      notes: [note({ id: 'n1', lamport: 4, deviceId: 'device-b' })],
    };

    const merged = mergeBothDirections(payload(deviceA), payload(deviceB));

    // Named so the case fails on a WRONG winner rather than only on an
    // asymmetric one: `mergeBothDirections` alone would pass if both
    // directions agreed on the same wrong answer.
    assert.deepEqual(
      merged.snapshot.lists.map((entry) => entry.name),
      ['a-l1', 'a-l2'],
      'the list winners are wrong',
    );
    assert.deepEqual(
      merged.snapshot.listItems.map((entry) => `${entry.id}:${entry.deviceId}`),
      ['i1:device-b', 'i2:device-a', 'i3:device-b'],
      'the list-item winners are wrong',
    );
    assert.deepEqual(
      merged.snapshot.notes.map((entry) => `${entry.id}:${entry.deviceId}`),
      ['n1:device-b'],
      'the note winners are wrong',
    );
  });
});
