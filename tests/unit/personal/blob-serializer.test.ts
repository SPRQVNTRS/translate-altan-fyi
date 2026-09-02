/**
 * The search log never leaves the device — proved on the actual bytes, not on
 * the projection alone.
 *
 * WHAT THIS PROTECTS
 *   `app/lib/e2ee/BLOB-CONTENTS.md` says the encrypted blob carries lists,
 *   list items and notes, and deliberately not the search log. That is a
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
 *     three synced collections are asserted to survive the round trip intact,
 *     stamps included.
 *   - Drift from PROTOCOL.md §3.2's payload shape, whose keys are transcribed
 *     below as a literal and compared against what the client actually builds.
 *
 * WHAT THIS FILE DOES NOT PROVE, AND WHERE THE PROOF ACTUALLY IS
 *   `toSyncedSnapshot` has NO CALLERS in the application today. The live sync
 *   path builds the projection by hand instead, in
 *   `app/lib/sync/local-store-bridge.ts`'s `readLocalSnapshot`, which reads the
 *   three synced collections and never touches the search log. That function
 *   resolves the browser IndexedDB singleton and so cannot be driven from a
 *   unit test at all — `tests/integration/personal-sync-push.test.ts` mirrors
 *   it and asserts against the ciphertext column, which is the on-path proof.
 *   This file covers the exported projection and the envelope; do not read it
 *   as covering the path a real device takes.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { buildEnvelope, parseEnvelope } from '#app/lib/sync/engine/envelope/build-envelope';
import type { SyncPayload } from '#app/lib/sync/engine/envelope/types';
import { toWireMeta } from '#app/lib/sync/snapshot-sync';
import {
  SCHEMA_VERSION,
  syncedSnapshotSchema,
  toSyncedSnapshot,
  type LocalStoreSnapshot,
} from '#app/lib/local-store';

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
    assert.deepEqual(Object.keys(synced).toSorted(), ['listItems', 'lists', 'notes']);
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
  it('carries the three synced collections through intact, stamps included', async () => {
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
});
