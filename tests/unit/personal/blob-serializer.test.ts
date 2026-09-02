/**
 * The search log never leaves the device, and review state does — both proved
 * on the actual bytes, not on the projection alone.
 *
 * WHAT THIS PROTECTS
 *   `app/lib/e2ee/BLOB-CONTENTS.md` says the encrypted blob carries lists,
 *   list items, notes and review state, and deliberately not the search log. That is a
 *   privacy promise made in copy on `/settings`, and the only thing that keeps
 *   it true is `toSyncedSnapshot` dropping the collection plus nothing
 *   downstream putting it back.
 *
 * THE DEFECTS THESE CASES CATCH
 *   - `toSyncedSnapshot` emitting `history: []`. An empty array still travels,
 *     and a future write path could fill it. The assertion is therefore that
 *     the KEY IS ABSENT, not that it is empty.
 *   - History smuggled back in under another name anywhere between the
 *     projection and the wire. A structural check on the parsed object passes
 *     if a refactor tucks the queries into `syncMeta` or into a new key, so
 *     the round-tripped payload is ALSO checked as serialized text for the
 *     distinctive query strings the fixture puts in the log.
 *   - The reverse failure, a test that passes by serializing nothing: the
 *     four synced collections are asserted to survive the round trip intact,
 *     stamps included.
 *   - Review state added to the local store but forgotten on one of the four
 *     seams it has to cross (the projection, the zod reader, the live bridge
 *     read, the merge). Any one of those omissions would leave a person's
 *     flashcard record stranded on one device while every other test stayed
 *     green, so the `review` cases below drive the projection, the encrypted
 *     round trip AND the live read.
 *   - Drift from PROTOCOL.md §3.2's payload shape, whose keys are transcribed
 *     below as a literal and compared against what the client actually builds.
 *   - A projection that quietly drops soft-deleted rows. A delete that is
 *     filtered out of the read never reaches the peer, so the other device
 *     keeps the row and pushes it back: the deletion is undone in the field
 *     while every naive test stays green. The last describe writes a tombstone
 *     and asserts it survives.
 *
 * THE PATH A REAL DEVICE TAKES IS COVERED HERE, NOT ONLY MIRRORED
 *   `app/lib/sync/local-store-bridge.ts`'s `readLocalSnapshot` is the live push
 *   path's read, and it hands its three reads to `toSyncedSnapshot` rather than
 *   naming the collections a second time. It takes `{ store }`, so the last
 *   describe drives THAT function against a real in-memory store, written
 *   through the app's own write helpers so the rows carry the stamps the app
 *   stamps. This matters because the arrangement used to be the other way
 *   round: the bridge built the projection by hand and `toSyncedSnapshot` had
 *   no callers, so this file was green over a guarantee nothing on the live
 *   path was keeping. `tests/integration/personal-sync-push.test.ts` asserts
 *   the same promise one layer further out, against the stored ciphertext.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Store } from 'tinybase';

import { buildEnvelope, parseEnvelope } from '#app/lib/sync/engine/envelope/build-envelope';
import type { SyncPayload } from '#app/lib/sync/engine/envelope/types';
import { toWireMeta } from '#app/lib/sync/snapshot-sync';
import {
  createPrimaryStore,
  deleteLocalNote,
  listHistory,
  putLocalList,
  putLocalListItem,
  putLocalNote,
  putLocalReviewState,
  recordSearch,
  SCHEMA_VERSION,
  syncedSnapshotSchema,
  toSyncedSnapshot,
  type LocalStoreSnapshot,
} from '#app/lib/local-store';
import { readLocalSnapshot } from '#app/lib/sync/local-store-bridge';

/**
 * A fixed, throwaway DEK. Not derived from anything and not a secret: this
 * file encrypts a fixture and immediately decrypts it again.
 */
const DEK = Uint8Array.from({ length: 32 }, (_, index) => (index * 37 + 11) % 256);

/** The AAD triple PROTOCOL.md §3.2 binds. The same triple is presented on the way back in. */
const AAD_FIELDS = { accountId: 4242, blobVersion: 7, payloadSchemaVersion: SCHEMA_VERSION };

/**
 * Queries chosen to be unmistakable in a byte-level search AND to be the kind
 * of thing a person would be alarmed to find on a server. If any of these
 * strings reaches the ciphertext's plaintext, the promise is broken.
 */
const PRIVATE_QUERIES = ['zzq-insolvenzberatung', 'zzq-schwangerschaftsabbruch', 'zzq-kuendigungsschutzklage'];

const UPDATED_AT = 1_760_000_000_000;

function deviceSnapshot(): LocalStoreSnapshot {
  return {
    lists: [
      { id: 'l1', name: 'Reise', languagePair: 'de-en', lamport: 3, deviceId: 'device-a', updatedAt: UPDATED_AT, deleted: false },
    ],
    listItems: [
      {
        id: 'i1',
        listId: 'l1',
        headwordId: 'hw-1',
        senseId: 'sense-1',
        lemma: 'Fahrkarte',
        translationSnapshot: 'ticket',
        note: 'am Automaten',
        lamport: 2,
        deviceId: 'device-a',
        updatedAt: UPDATED_AT,
        deleted: false,
      },
    ],
    notes: [
      { id: 'n1', headwordId: 'hw-1', text: 'mit Umlaut', lamport: 5, deviceId: 'device-b', updatedAt: UPDATED_AT, deleted: false },
      // A tombstone, so the wire meta below actually carries one.
      { id: 'n2', headwordId: 'hw-2', text: 'gelöscht', lamport: 6, deviceId: 'device-b', updatedAt: UPDATED_AT, deleted: true },
    ],
    // Keyed by the LIST ENTRY's id, which is why the merge namespaces it.
    reviewState: [
      {
        id: 'i1',
        gotItCount: 2,
        stillLearningCount: 3,
        lastReviewedAt: UPDATED_AT,
        lamport: 4,
        deviceId: 'device-a',
        updatedAt: UPDATED_AT,
        deleted: false,
      },
    ],
    history: PRIVATE_QUERIES.map((query, index) => ({
      id: `h${index}`,
      query,
      from: 'de',
      to: 'en',
      headwordId: null,
      at: UPDATED_AT - index * 1000,
    })),
  };
}

/** The payload the orchestrator sends: the projection plus the meta projected from it. */
function wirePayload(): SyncPayload {
  const synced = toSyncedSnapshot(deviceSnapshot());
  return { snapshot: synced, syncMeta: toWireMeta(synced) };
}

describe('the sync projection drops the search log', () => {
  it('emits no history key at all, not an empty one', () => {
    const device = deviceSnapshot();
    assert.ok(device.history.length > 0, 'the fixture must carry history for this assertion to mean anything');

    const synced = toSyncedSnapshot(device);

    // ABSENT, not empty: `history: []` would still travel, and would be a
    // container a later write path could fill without anyone noticing.
    assert.ok(!('history' in synced), 'the projection carries a history key');
    assert.deepEqual(Object.keys(synced).toSorted(), ['listItems', 'lists', 'notes', 'reviewState']);
  });
});

describe('the sync projection carries review state', () => {
  it('keeps the flashcard tally and its stamp, so a second device inherits it', () => {
    const device = deviceSnapshot();
    assert.ok(device.reviewState.length > 0, 'the fixture must carry review state for this assertion to mean anything');

    const synced = toSyncedSnapshot(device);

    assert.deepEqual(synced.reviewState, device.reviewState, 'the projection dropped or reshaped the review state');
    const [state] = synced.reviewState;
    assert.ok(state !== undefined);
    // The tally AND the ordering pair: a projection that carried the counts
    // but lost the stamp would sync a row that can never win a merge.
    assert.equal(state.gotItCount, 2);
    assert.equal(state.stillLearningCount, 3);
    assert.equal(state.deviceId, 'device-a');
    assert.ok(state.lamport > 0);
  });

  it('carries no scheduling field, because there is no schedule to carry', () => {
    const [state] = toSyncedSnapshot(deviceSnapshot()).reviewState;
    assert.ok(state !== undefined);

    assert.deepEqual(
      Object.keys(state).toSorted(),
      ['deleted', 'deviceId', 'gotItCount', 'id', 'lamport', 'lastReviewedAt', 'stillLearningCount', 'updatedAt'],
      'a field the no-scheduling rule did not sanction reached the blob',
    );
  });

  it('reads a v1 blob, which had no review state, as an empty collection rather than a refusal', () => {
    // A peer still on SCHEMA_VERSION 1 writes a payload with three
    // collections. The reader must not reject it, and must not invent rows.
    const legacy = { lists: [], listItems: [], notes: [] };

    const parsed = syncedSnapshotSchema.parse(legacy);

    assert.deepEqual(parsed.reviewState, [], 'an older peer’s blob did not read as "no review state"');
  });
});

describe('the payload shape (PROTOCOL.md §3.2)', () => {
  /**
   * Transcribed from §3.2's payload block. The document's own key names, so a
   * rename on either side shows up here instead of at a peer that cannot read
   * the blob.
   */
  const DOCUMENTED_PAYLOAD_KEYS = ['snapshot', 'syncMeta'];
  const DOCUMENTED_SYNC_META_KEYS = ['perEntity', 'tombstones'];
  const DOCUMENTED_TOMBSTONE_KEYS = ['deviceId', 'entityId', 'entityType', 'lamport'];

  it('builds exactly the documented keys', () => {
    const payload = wirePayload();

    assert.deepEqual(Object.keys(payload).toSorted(), DOCUMENTED_PAYLOAD_KEYS.toSorted());
    assert.deepEqual(Object.keys(payload.syncMeta).toSorted(), DOCUMENTED_SYNC_META_KEYS.toSorted());

    const [tombstone] = payload.syncMeta.tombstones;
    assert.ok(tombstone !== undefined, 'the fixture must produce a tombstone for the shape below to be checked');
    assert.deepEqual(Object.keys(tombstone).toSorted(), DOCUMENTED_TOMBSTONE_KEYS.toSorted());
  });
});

describe('the encrypted round trip', () => {
  it('carries the four synced collections through intact, stamps included', async () => {
    const envelope = await buildEnvelope({ payload: wirePayload(), dek: DEK, aadFields: AAD_FIELDS });
    const parsed = await parseEnvelope({ envelope, dek: DEK, aadFields: AAD_FIELDS });

    const snapshot = syncedSnapshotSchema.parse(parsed.snapshot);
    assert.deepEqual(snapshot, toSyncedSnapshot(deviceSnapshot()), 'the synced collections did not survive the round trip');
    assert.deepEqual(parsed.syncMeta, toWireMeta(toSyncedSnapshot(deviceSnapshot())), 'the wire meta did not survive');
  });

  it('carries none of the search log, structurally or as bytes', async () => {
    const envelope = await buildEnvelope({ payload: wirePayload(), dek: DEK, aadFields: AAD_FIELDS });
    const parsed = await parseEnvelope({ envelope, dek: DEK, aadFields: AAD_FIELDS });

    const serialized = JSON.stringify(parsed);

    // The substring check is the one that survives a refactor: a structural
    // assertion passes if the queries are smuggled in under another key.
    for (const query of PRIVATE_QUERIES) {
      assert.ok(!serialized.includes(query), 'a recorded search reached the encrypted payload');
    }
    assert.ok(!serialized.includes('history'), 'the word history reached the encrypted payload');

    // And the check is not vacuous: the lists DID make the trip through the
    // same serialization.
    assert.ok(serialized.includes('Fahrkarte'), 'the round trip carried no list items, so the checks above prove nothing');
  });

  it('carries the review tally through the ciphertext, read back off the parsed bytes', async () => {
    const envelope = await buildEnvelope({ payload: wirePayload(), dek: DEK, aadFields: AAD_FIELDS });
    const parsed = await parseEnvelope({ envelope, dek: DEK, aadFields: AAD_FIELDS });

    const snapshot = syncedSnapshotSchema.parse(parsed.snapshot);
    assert.deepEqual(
      snapshot.reviewState,
      deviceSnapshot().reviewState,
      'the review state did not survive the encrypted round trip',
    );
    // And it is addressable in the wire meta under its own namespace, so a
    // review state and the list entry that shares its id cannot collide.
    assert.ok(
      Object.keys(parsed.syncMeta.perEntity).includes('reviewState:i1'),
      'the review state is missing from the wire meta, so a merge cannot order it',
    );
    assert.ok(
      Object.keys(parsed.syncMeta.perEntity).includes('listItem:i1'),
      'the list entry with the same id vanished, so the namespaces are colliding',
    );
  });
});

describe('the live sync read (app/lib/sync/local-store-bridge.ts)', () => {
  /**
   * A device as the app itself would leave it: four synced collections
   * written through the real helpers, one of the notes then soft-deleted, and
   * a search log beside them. Nothing here builds a snapshot literal — the
   * rows carry whatever stamp the write helpers give them.
   */
  async function writtenDevice(): Promise<Store> {
    const store = createPrimaryStore();
    const options = { store, deviceId: 'device-a', now: () => UPDATED_AT };

    await putLocalList({ id: 'l1', name: 'Reise', languagePair: 'de-en' }, options);
    await putLocalListItem(
      {
        id: 'i1',
        listId: 'l1',
        headwordId: 'hw-1',
        senseId: 'sense-1',
        lemma: 'Fahrkarte',
        translationSnapshot: 'ticket',
        note: 'am Automaten',
      },
      options,
    );
    await putLocalNote({ id: 'n1', headwordId: 'hw-1', text: 'mit Umlaut' }, options);
    await putLocalNote({ id: 'n2', headwordId: 'hw-2', text: 'gelöscht' }, options);
    await putLocalReviewState(
      { id: 'i1', gotItCount: 2, stillLearningCount: 3, lastReviewedAt: UPDATED_AT },
      options,
    );
    // A real deletion, through the real helper: a soft delete that bumps the
    // lamport, which is the only thing that can beat a peer still holding the
    // live row.
    await deleteLocalNote('n2', options);

    for (const query of PRIVATE_QUERIES) {
      await recordSearch({ query, from: 'de', to: 'en', headwordId: null }, { store, now: () => UPDATED_AT });
    }
    return store;
  }

  it('carries the four synced collections and no search log', async () => {
    const store = await writtenDevice();
    assert.equal((await listHistory({ store })).length, PRIVATE_QUERIES.length, 'the log must be in the store for this to mean anything');

    const snapshot = await readLocalSnapshot({ store });

    // ABSENT, not empty — the same rule the projection is held to, asserted on
    // the function a device actually calls.
    assert.ok(!('history' in snapshot), 'the live read carries a history key');
    assert.deepEqual(Object.keys(snapshot).toSorted(), ['listItems', 'lists', 'notes', 'reviewState']);
    assert.deepEqual(snapshot.lists.map((list) => list.id), ['l1']);
    assert.deepEqual(snapshot.listItems.map((item) => item.id), ['i1']);
    assert.deepEqual(snapshot.reviewState.map((state) => state.id), ['i1']);

    // And as bytes, which survives a refactor that tucks the queries under
    // another key: a structural check would not.
    const serialized = JSON.stringify(snapshot);
    for (const query of PRIVATE_QUERIES) {
      assert.ok(!serialized.includes(query), 'a recorded search reached the live sync read');
    }
    assert.ok(serialized.includes('Fahrkarte'), 'the read returned no list items, so the checks above prove nothing');
  });

  it('carries the review state written through the real helper, stamped by this device', async () => {
    const store = await writtenDevice();

    const snapshot = await readLocalSnapshot({ store });

    const [state] = snapshot.reviewState;
    assert.ok(state !== undefined, 'the live read carries no review state');
    assert.equal(state.gotItCount, 2);
    assert.equal(state.stillLearningCount, 3);
    // Written through `putLocalReviewState`, so the stamp is the store's, not
    // a literal this file made up.
    assert.equal(state.deviceId, 'device-a');
    assert.ok(state.lamport > 0, 'the review state left the device unstamped, so it can never win a merge');
    assert.equal(state.deleted, false);
  });

  it('carries the tombstone, so a deletion actually reaches the peer', async () => {
    const store = await writtenDevice();
    const snapshot = await readLocalSnapshot({ store });

    assert.deepEqual(snapshot.notes.map((note) => note.id), ['n1', 'n2'], 'the deleted note was filtered out of the push');

    const [live, tombstone] = snapshot.notes;
    assert.ok(live !== undefined && tombstone !== undefined);
    // The pair together: the tombstone travels marked dead, and the live row
    // travels marked alive, so this is a real distinction and not a reader
    // that stamps everything the same.
    assert.equal(tombstone.deleted, true, 'the tombstone lost its deleted flag');
    assert.equal(live.deleted, false);
    // A tombstone only wins a merge if it outranks the peer's live copy, so
    // the bumped lamport is part of what has to survive the read.
    assert.ok(tombstone.lamport > live.lamport, 'the tombstone did not carry the bumped lamport');
  });
});
