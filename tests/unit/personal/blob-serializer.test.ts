/**
 * The search log never leaves the device, and review state and favourites do —
 * all three proved on the actual bytes, not on the projection alone.
 *
 * WHAT THIS PROTECTS
 *   `app/lib/local-store/BLOB-CONTENTS.md` says the blob carries lists, list
 *   items, notes, review state and favourites, and deliberately not the search log. That is a
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
 *     five synced collections are asserted to survive the round trip intact,
 *     stamps included.
 *   - Review state added to the local store but forgotten on one of the four
 *     seams it has to cross (the projection, the zod reader, the live bridge
 *     read, the merge). Any one of those omissions would leave a person's
 *     flashcard record stranded on one device while every other test stayed
 *     green, so the `review` cases below drive the projection, the encrypted
 *     round trip AND the live read.
 *   - Favourites forgotten on any of those same four seams, which is the same
 *     defect one collection later: a word starred on a phone would never reach
 *     the laptop, and the reader would be told their favourites sync. The
 *     `favourite` cases below drive the same three paths the review ones do.
 *   - Drift from the payload shape, whose keys are transcribed
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
import { jsonValueSchema } from '#app/lib/json';
import {
  createPrimaryStore,
  deleteLocalNote,
  listHistory,
  putFavorite,
  removeFavorite,
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
    favorites: [
      {
        id: 'hw-1::sense-1::en',
        headwordId: 'hw-1',
        senseId: 'sense-1',
        lemma: 'Fahrkarte',
        translationSnapshot: 'ticket',
        from: 'de',
        to: 'en',
        lamport: 1,
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
      translation: null,
      at: UPDATED_AT - index * 1000,
    })),
  };
}

/**
 * One full trip through the wire framing: build the envelope, serialize it as
 * the transport does, and read it back through the decoder.
 *
 * THE `JSON.parse(JSON.stringify(...))` IS THE POINT, not ceremony. The
 * envelope is stored as `jsonb` and returned over HTTP, so anything that does
 * not survive JSON is not actually being carried; asserting against the object
 * this file just built would prove nothing about the wire.
 */
function roundTrip(): SyncPayload {
  const envelope = buildEnvelope({ payload: wirePayload(), blobVersion: 1, payloadSchemaVersion: SCHEMA_VERSION });
  const decoded = jsonValueSchema.parse(JSON.parse(JSON.stringify(envelope)));
  return parseEnvelope(decoded).payload;
}

/** The payload the orchestrator sends: the projection plus the meta projected from it. */
function wirePayload(): SyncPayload {
  const synced = toSyncedSnapshot(deviceSnapshot());
  // SAFETY: `SyncedSnapshot` is a tree of plain JSON values, which is what
  // `JsonValue` names. The envelope deliberately does not know the snapshot's
  // real shape, so the widening happens at every call site that builds one.
  return { snapshot: jsonValueSchema.parse(synced), syncMeta: toWireMeta(synced) };
}

describe('the sync projection drops the search log', () => {
  it('emits no history key at all, not an empty one', () => {
    const device = deviceSnapshot();
    assert.ok(device.history.length > 0, 'the fixture must carry history for this assertion to mean anything');

    const synced = toSyncedSnapshot(device);

    // ABSENT, not empty: `history: []` would still travel, and would be a
    // container a later write path could fill without anyone noticing.
    assert.ok(!('history' in synced), 'the projection carries a history key');
    assert.deepEqual(Object.keys(synced).toSorted(), ['favorites', 'listItems', 'lists', 'notes', 'reviewState']);
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

describe('the sync projection carries favourites', () => {
  it('keeps the word, the answer, the pair and the stamp', () => {
    const device = deviceSnapshot();
    assert.ok(device.favorites.length > 0, 'the fixture must carry a favourite for this assertion to mean anything');

    const synced = toSyncedSnapshot(device);

    assert.deepEqual(synced.favorites, device.favorites, 'the projection dropped or reshaped the favourites');
    const [favorite] = synced.favorites;
    assert.ok(favorite !== undefined);
    // The four fields the favourites screen renders, plus the ordering pair. A
    // projection that carried the word but lost `to` would sync a row nobody
    // can say the language of, and one that lost the stamp would sync a row
    // that can never win a merge.
    assert.equal(favorite.lemma, 'Fahrkarte');
    assert.equal(favorite.translationSnapshot, 'ticket');
    assert.equal(favorite.from, 'de');
    assert.equal(favorite.to, 'en');
    assert.equal(favorite.deviceId, 'device-a');
    assert.ok(favorite.lamport > 0);
  });

  it('reads a v2 blob, which had no favourites, as an empty collection rather than a refusal', () => {
    // A peer still on SCHEMA_VERSION 2 writes a payload with four
    // collections. The reader must not reject it, and must not invent rows.
    const legacy = { lists: [], listItems: [], notes: [], reviewState: [] };

    const parsed = syncedSnapshotSchema.parse(legacy);

    assert.deepEqual(parsed.favorites, [], 'an older peer\u2019s blob did not read as "no favourites"');
  });
});

describe('the payload shape', () => {
  /**
   * The payload's key names, transcribed as a literal, so a rename on either
   * side shows up here instead of at a peer that cannot read the document.
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

describe('the envelope round trip', () => {
  it('carries the five synced collections through intact, stamps included', () => {
    const parsed = roundTrip();

    const snapshot = syncedSnapshotSchema.parse(parsed.snapshot);
    assert.deepEqual(snapshot, toSyncedSnapshot(deviceSnapshot()), 'the synced collections did not survive the round trip');
    assert.deepEqual(parsed.syncMeta, toWireMeta(toSyncedSnapshot(deviceSnapshot())), 'the wire meta did not survive');
  });

  it('carries none of the search log, structurally or as bytes', () => {
    const parsed = roundTrip();

    const serialized = JSON.stringify(parsed);

    // The substring check is the one that survives a refactor: a structural
    // assertion passes if the queries are smuggled in under another key.
    for (const query of PRIVATE_QUERIES) {
      assert.ok(!serialized.includes(query), 'a recorded search reached the synced payload');
    }
    assert.ok(!serialized.includes('history'), 'the word history reached the synced payload');

    // And the check is not vacuous: the lists DID make the trip through the
    // same serialization.
    assert.ok(serialized.includes('Fahrkarte'), 'the round trip carried no list items, so the checks above prove nothing');
  });

  it('carries the favourite through the round trip, addressable under its own namespace', () => {
    const parsed = roundTrip();

    const snapshot = syncedSnapshotSchema.parse(parsed.snapshot);
    assert.deepEqual(snapshot.favorites, deviceSnapshot().favorites, 'the favourite did not survive the round trip');
    assert.ok(
      Object.keys(parsed.syncMeta.perEntity).includes('favorite:hw-1::sense-1::en'),
      'the favourite is missing from the wire meta, so a merge cannot order it',
    );
  });

  it('carries the review tally through the round trip, read back off the parsed payload', () => {
    const parsed = roundTrip();

    const snapshot = syncedSnapshotSchema.parse(parsed.snapshot);
    assert.deepEqual(
      snapshot.reviewState,
      deviceSnapshot().reviewState,
      'the review state did not survive the round trip',
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
    // Two favourites written through the real helper, one of them then
    // removed. The removed one is what proves a star turned off travels as a
    // tombstone rather than simply vanishing from the push.
    await putFavorite(
      { headwordId: 'hw-1', senseId: null, lemma: 'Fahrkarte', translationSnapshot: 'ticket', from: 'de', to: 'en' },
      options,
    );
    await putFavorite(
      { headwordId: 'hw-2', senseId: null, lemma: 'Bahnhof', translationSnapshot: 'station', from: 'de', to: 'en' },
      options,
    );
    await removeFavorite('hw-2::::en', options);
    // A real deletion, through the real helper: a soft delete that bumps the
    // lamport, which is the only thing that can beat a peer still holding the
    // live row.
    await deleteLocalNote('n2', options);

    for (const query of PRIVATE_QUERIES) {
      await recordSearch({ query, from: 'de', to: 'en', headwordId: null, translation: null }, { store, now: () => UPDATED_AT });
    }
    return store;
  }

  it('carries the five synced collections and no search log', async () => {
    const store = await writtenDevice();
    assert.equal((await listHistory({ store })).length, PRIVATE_QUERIES.length, 'the log must be in the store for this to mean anything');

    const snapshot = await readLocalSnapshot({ store });

    // ABSENT, not empty — the same rule the projection is held to, asserted on
    // the function a device actually calls.
    assert.ok(!('history' in snapshot), 'the live read carries a history key');
    assert.deepEqual(Object.keys(snapshot).toSorted(), ['favorites', 'listItems', 'lists', 'notes', 'reviewState']);
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

  it('carries both favourites, the removed one as a tombstone', async () => {
    const store = await writtenDevice();

    const snapshot = await readLocalSnapshot({ store });

    assert.deepEqual(
      snapshot.favorites.map((favorite) => favorite.id).toSorted(),
      ['hw-1::::en', 'hw-2::::en'],
      'the removed favourite was filtered out of the push, so the peer will put it back',
    );
    const removed = snapshot.favorites.find((favorite) => favorite.id === 'hw-2::::en');
    const kept = snapshot.favorites.find((favorite) => favorite.id === 'hw-1::::en');
    assert.ok(removed !== undefined && kept !== undefined);
    assert.equal(removed.deleted, true, 'the removed favourite lost its deleted flag');
    assert.equal(kept.deleted, false);
    assert.ok(removed.lamport > kept.lamport, 'the tombstone did not carry the bumped lamport');
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
