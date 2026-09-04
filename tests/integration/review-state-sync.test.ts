/**
 * Two devices reviewing the same words, against the real database.
 *
 * WHAT THIS IS ACTUALLY ABOUT. The flashcard loop writes review state on the
 * device that ran the session, and the whole promise of an account is that the
 * OTHER device knows about it. That promise is kept by three things standing in
 * a row: the compare-and-swap in Postgres, the Lamport merge in
 * `snapshot-sync.ts`, and the client loop that reacts to a lost race by
 * pulling, merging and pushing again. Each is tested on its own. This walks the
 * three of them together, because the failure they produce jointly is silent:
 * one device's counts vanish and nothing anywhere reports an error.
 *
 * THE SECOND WRITER IS REAL, NOT SIMULATED. It pushes against the version it
 * last agreed with, loses, reads what actually won, merges against that, and
 * pushes again. Faking the conflict would test the assertion, not the system.
 *
 * WHAT WOULD PASS A WEAKER TEST AND FAIL HERE: a last-write-wins upsert. It
 * accepts both pushes in order, reports no error, and leaves the first device's
 * review counts gone.
 *
 * ISOLATION. One user per case, deleted by id in `after()`.
 */
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { eq } from 'drizzle-orm';

import { closePool, db, poolInitialized } from '../../drizzle/db';
import { users } from '../../drizzle/schema';
import { jsonValueSchema, type JsonValue } from '../../app/lib/json';
import { parseEnvelope } from '../../app/lib/sync/engine/envelope/build-envelope';
import { syncedSnapshotSchema, type SyncedSnapshot } from '../../app/lib/local-store';
import { mergeSnapshots, toWireMeta, type StampedSnapshot } from '../../app/lib/sync/snapshot-sync';
import { putBlobIfVersionMatches, readBlob } from '../../app/lib/sync/server/blob-store.server';

/**
 * Every case self-skips on this, INLINE rather than through a shared constant.
 * `tests/unit/integration-tests-self-skip.test.ts` reads the source text and
 * wants the precondition visible at the case, because a guard hidden behind a
 * name is a guard the next reader deletes without noticing.
 */
const DB_HOST = process.env.DB_HOST;

const createdUserIds: number[] = [];

/** One review row, as the flashcard loop writes it. */
function reviewRow(input: {
  id: string;
  deviceId: string;
  lamport: number;
  gotIt: number;
  stillLearning: number;
  at: number;
}): SyncedSnapshot['reviewState'][number] {
  return {
    id: input.id,
    gotItCount: input.gotIt,
    stillLearningCount: input.stillLearning,
    lastReviewedAt: input.at,
    lamport: input.lamport,
    deviceId: input.deviceId,
    updatedAt: input.at,
    deleted: false,
  };
}

/** A device's whole synced state, with review rows and nothing else. */
function deviceSnapshot(reviewState: SyncedSnapshot['reviewState']): StampedSnapshot {
  const snapshot: SyncedSnapshot = { lists: [], listItems: [], notes: [], reviewState };
  return { snapshot, meta: toWireMeta(snapshot) };
}

/** The document as it is stored: the envelope the client builds around a stamped payload. */
function envelopeFor(payload: StampedSnapshot, blobVersion: number): JsonValue {
  // Parsed rather than asserted, exactly as `orchestrator.ts` frames it. It is
  // also the one check that the whole envelope really is JSON: nothing in the
  // types says a stamped snapshot has to be.
  return jsonValueSchema.parse({
    payloadSchemaVersion: 2,
    blobVersion,
    payload: { snapshot: payload.snapshot, syncMeta: payload.meta },
  });
}

/**
 * A stored document, read back as the orchestrator reads it.
 *
 * It goes through `parseEnvelope` and `syncedSnapshotSchema` rather than an
 * assertion, which is the same pair of decodes the real pull performs: a
 * document either of them refuses is a document this test must not silently
 * accept either.
 */
function stampedFromStored(stored: JsonValue): StampedSnapshot {
  const envelope = parseEnvelope(stored);
  return { snapshot: syncedSnapshotSchema.parse(envelope.payload.snapshot), meta: envelope.payload.syncMeta };
}

function sizeOf(payload: JsonValue): number {
  return new TextEncoder().encode(JSON.stringify(payload)).byteLength;
}

async function seedUser(label: string): Promise<number> {
  const [row] = await db
    .insert(users)
    .values({
      email: `zzreview-${label}-${Date.now()}-${createdUserIds.length}@example.invalid`,
      passwordHash: '$2b$10$abcdefghijklmnopqrstuvwxyz012345678901234567890123456789',
    })
    .returning({ id: users.id });
  assert.ok(row, 'could not seed the fixture user');
  createdUserIds.push(row.id);
  return row.id;
}

/** The review rows of the currently stored document, by id. */
async function storedReviewById(userId: number): Promise<Map<string, SyncedSnapshot['reviewState'][number]>> {
  const stored = await readBlob(userId);
  assert.ok(stored, 'there is no stored document to read');
  return new Map(stampedFromStored(stored.payload).snapshot.reviewState.map((row) => [row.id, row]));
}

after(async () => {
  for (const id of createdUserIds) {
    await db.delete(users).where(eq(users.id, id));
  }
  await poolInitialized;
  await closePool();
});

describe('two devices reviewing the same account', () => {
  it('keeps both devices work after the loser merges and pushes again', { skip: !DB_HOST ? 'DB_HOST not set' : false }, async () => {
    const userId = await seedUser('two-writers');

    // The phone reviews one word and wins the race.
    const phone = deviceSnapshot([
      reviewRow({ id: 'item-a', deviceId: 'phone', lamport: 3, gotIt: 2, stillLearning: 0, at: 1_764_000_000_000 }),
    ]);
    const firstPush = envelopeFor(phone, 1);
    assert.deepEqual(
      await putBlobIfVersionMatches({ userId, baseVersion: 0, payload: firstPush, sizeBytes: sizeOf(firstPush) }),
      { status: 'accepted', newVersion: 1 },
    );

    // The laptop reviewed a DIFFERENT word offline, and still believes the
    // document is at version 0.
    const laptop = deviceSnapshot([
      reviewRow({ id: 'item-b', deviceId: 'laptop', lamport: 4, gotIt: 0, stillLearning: 5, at: 1_764_000_100_000 }),
    ]);
    const lostRace = envelopeFor(laptop, 1);
    const conflict = await putBlobIfVersionMatches({
      userId,
      baseVersion: 0,
      payload: lostRace,
      sizeBytes: sizeOf(lostRace),
    });
    assert.deepEqual(conflict, { status: 'conflict', currentVersion: 1 });

    // The recovery loop, exactly as `orchestrator.ts` runs it.
    const current = await readBlob(userId);
    assert.ok(current);
    const merged = mergeSnapshots({ local: laptop, remote: stampedFromStored(current.payload) });
    const secondPush = envelopeFor(merged, 2);
    assert.deepEqual(
      await putBlobIfVersionMatches({
        userId,
        baseVersion: current.blobVersion,
        payload: secondPush,
        sizeBytes: sizeOf(secondPush),
      }),
      { status: 'accepted', newVersion: 2 },
    );

    // Both devices' sessions survived. This is the assertion a last-write-wins
    // upsert fails.
    const stored = await storedReviewById(userId);
    assert.equal(stored.size, 2, `the merged document holds ${stored.size} review rows, expected both`);
    assert.equal(stored.get('item-a')?.gotItCount, 2, "the phone's counts were lost");
    assert.equal(stored.get('item-b')?.stillLearningCount, 5, "the laptop's counts were lost");
  });

  it('lets the higher stamp win when both devices reviewed the same word', { skip: !DB_HOST ? 'DB_HOST not set' : false }, async () => {
    const userId = await seedUser('same-word');

    const earlier = deviceSnapshot([
      reviewRow({ id: 'item-a', deviceId: 'phone', lamport: 3, gotIt: 1, stillLearning: 0, at: 1_764_000_000_000 }),
    ]);
    const first = envelopeFor(earlier, 1);
    await putBlobIfVersionMatches({ userId, baseVersion: 0, payload: first, sizeBytes: sizeOf(first) });

    // The same word, reviewed again on the laptop. A higher Lamport stamp means
    // "this happened after", and it is what decides the winner, never the
    // arrival order.
    const later = deviceSnapshot([
      reviewRow({ id: 'item-a', deviceId: 'laptop', lamport: 9, gotIt: 4, stillLearning: 1, at: 1_764_000_500_000 }),
    ]);
    const current = await readBlob(userId);
    assert.ok(current);
    const merged = mergeSnapshots({ local: later, remote: stampedFromStored(current.payload) });
    const second = envelopeFor(merged, 2);
    await putBlobIfVersionMatches({
      userId,
      baseVersion: current.blobVersion,
      payload: second,
      sizeBytes: sizeOf(second),
    });

    const stored = await storedReviewById(userId);
    assert.equal(stored.size, 1, 'one word became two rows');
    assert.equal(stored.get('item-a')?.gotItCount, 4);
    assert.equal(stored.get('item-a')?.deviceId, 'laptop');
  });

  it('does not let an older stamp overwrite a newer one, whichever pushes last', { skip: !DB_HOST ? 'DB_HOST not set' : false }, async () => {
    const userId = await seedUser('stale-stamp');

    const newer = deviceSnapshot([
      reviewRow({ id: 'item-a', deviceId: 'laptop', lamport: 9, gotIt: 4, stillLearning: 1, at: 1_764_000_500_000 }),
    ]);
    const first = envelopeFor(newer, 1);
    await putBlobIfVersionMatches({ userId, baseVersion: 0, payload: first, sizeBytes: sizeOf(first) });

    // A phone that was offline for a while and is only now catching up. Its row
    // is older, and merging must leave the newer one alone.
    const older = deviceSnapshot([
      reviewRow({ id: 'item-a', deviceId: 'phone', lamport: 2, gotIt: 1, stillLearning: 0, at: 1_764_000_000_000 }),
    ]);
    const current = await readBlob(userId);
    assert.ok(current);
    const merged = mergeSnapshots({ local: older, remote: stampedFromStored(current.payload) });
    const second = envelopeFor(merged, 2);
    await putBlobIfVersionMatches({
      userId,
      baseVersion: current.blobVersion,
      payload: second,
      sizeBytes: sizeOf(second),
    });

    const stored = await storedReviewById(userId);
    assert.equal(stored.get('item-a')?.gotItCount, 4, 'a stale device overwrote a newer review');
    assert.equal(stored.get('item-a')?.deviceId, 'laptop');
  });

  it('gives a device with nothing to say the account state as it stands', { skip: !DB_HOST ? 'DB_HOST not set' : false }, async () => {
    const userId = await seedUser('fresh-device');

    const existing = deviceSnapshot([
      reviewRow({ id: 'item-a', deviceId: 'phone', lamport: 3, gotIt: 2, stillLearning: 0, at: 1_764_000_000_000 }),
    ]);
    const pushed = envelopeFor(existing, 1);
    await putBlobIfVersionMatches({ userId, baseVersion: 0, payload: pushed, sizeBytes: sizeOf(pushed) });

    // A second device signing in for the first time: an empty local snapshot
    // merged against the account's document. It must ADOPT, never erase.
    const fresh = deviceSnapshot([]);
    const current = await readBlob(userId);
    assert.ok(current);
    const merged = mergeSnapshots({ local: fresh, remote: stampedFromStored(current.payload) });

    assert.equal(merged.snapshot.reviewState.length, 1, 'a fresh device erased the account state');
    assert.equal(merged.snapshot.reviewState[0]?.gotItCount, 2);
  });
});
