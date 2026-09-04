/**
 * The synced document, pushed and pulled back, against the real column.
 *
 * WHAT THIS PROVES THAT A UNIT TEST CANNOT. Three things live in Postgres and
 * nowhere else:
 *
 *   1. `sync_blobs.payload` is `jsonb`, so what comes back is what Postgres
 *      decided to store, not what this process handed over. A value the column
 *      cannot hold, or one it reshapes on the way through, shows up here and in
 *      no typecheck.
 *   2. The compare-and-swap is a `setWhere` clause on an upsert. Whether two
 *      writers can both win is a question only the database can answer.
 *   3. The unique index on `user_id` is what makes "the document" singular. A
 *      second row for the same user would make every pull a coin flip.
 *
 * THE ROUND TRIP IS ASSERTED ON THE ENCODING, not on a structural comparison. A
 * `deepEqual` accepts a `1` that came back as `"1"`, and the merge that reads
 * this document would then quietly do the wrong thing with it.
 *
 * THE ENCODING IS CANONICAL, WITH KEYS SORTED, AND THAT IS NOT A SHORTCUT. The
 * column is `jsonb`, which stores a parsed value rather than the text it was
 * given: it drops insignificant whitespace, keeps the last of any duplicate
 * key, and returns object keys in its own order, shortest first. Asserting the
 * literal bytes would therefore fail on a document that survived perfectly. It
 * is also safe to ignore that order here, because nothing downstream reads it:
 * `parseEnvelope` decodes with a schema, and `payloadsEqual` compares its own
 * canonical form (`snapshot-sync.ts`). What the sorted encoding still catches
 * is every difference that matters, a changed value, a changed TYPE, a dropped
 * key or an added one.
 *
 * ISOLATION. One user per case, deleted by id in `after()`. The blob rows
 * cascade with them.
 */
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { eq } from 'drizzle-orm';

import { closePool, db, poolInitialized } from '../../drizzle/db';
import { users } from '../../drizzle/schema';
import type { JsonValue } from '../../app/lib/json';
import { putBlobIfVersionMatches, readBlob } from '../../app/lib/sync/server/blob-store.server';

/**
 * Every case self-skips on this, INLINE rather than through a shared constant.
 * `tests/unit/integration-tests-self-skip.test.ts` reads the source text and
 * wants the precondition visible at the case, because a guard hidden behind a
 * name is a guard the next reader deletes without noticing.
 */
const DB_HOST = process.env.DB_HOST;

const createdUserIds: number[] = [];

/**
 * A document with one of everything JSON can carry, framed the way
 * `build-envelope.ts` frames it.
 *
 * The odd values are deliberate: a nested object, an empty array, an explicit
 * null, a negative integer, a float, a non-ASCII string and a string that looks
 * like a number are the seven shapes a JSON column, a driver or a serializer
 * most often mangles.
 */
function sampleEnvelope(seed: string): JsonValue {
  return {
    payloadSchemaVersion: 2,
    blobVersion: 1,
    payload: {
      snapshot: {
        lists: [{ id: `list-${seed}`, name: 'Türkçe kelimeler', deleted: false, position: -3 }],
        listItems: [],
        notes: [{ id: `note-${seed}`, body: 'gündüz\nnacht', rating: 0.5, archivedAt: null }],
        reviewState: [{ id: `review-${seed}`, box: '3', due: 1_764_000_000_000 }],
      },
      syncMeta: {
        perEntity: { [`list-${seed}`]: { lamport: 1, deviceId: 'device-a' } },
        tombstones: [],
      },
    },
  };
}

/** One user to hang a document off. The blob table's foreign key means there is no such thing as an ownerless blob. */
async function seedUser(label: string): Promise<number> {
  const [row] = await db
    .insert(users)
    .values({
      email: `zzblob-${label}-${Date.now()}-${createdUserIds.length}@example.invalid`,
      passwordHash: '$2b$10$abcdefghijklmnopqrstuvwxyz012345678901234567890123456789',
    })
    .returning({ id: users.id });
  assert.ok(row, 'could not seed the fixture user');
  createdUserIds.push(row.id);
  return row.id;
}

/**
 * A JSON encoding with every object's keys sorted, at every depth.
 *
 * See the module header for why this and not `JSON.stringify` alone. Array
 * order is left ALONE: an array is ordered data, and reordering one here would
 * hide a document that came back shuffled.
 */
function canonicalJson(value: JsonValue): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value === null || !(value instanceof Object)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .toSorted(([a], [b]) => (a < b ? -1 : 1))
      .map(([key, nested]) => [key, sortKeys(nested)]),
  );
}

/** The measured size the route would report, so the fixture pushes what the real caller pushes. */
function sizeOf(payload: JsonValue): number {
  return new TextEncoder().encode(JSON.stringify(payload)).byteLength;
}

after(async () => {
  for (const id of createdUserIds) {
    await db.delete(users).where(eq(users.id, id));
  }
  await poolInitialized;
  await closePool();
});

describe('the synced document round trips as plain JSON', () => {
  it('gives back exactly what was pushed', { skip: !DB_HOST ? 'DB_HOST not set' : false }, async () => {
    const userId = await seedUser('round-trip');
    const payload = sampleEnvelope('one');

    const pushed = await putBlobIfVersionMatches({ userId, baseVersion: 0, payload, sizeBytes: sizeOf(payload) });
    assert.deepEqual(pushed, { status: 'accepted', newVersion: 1 });

    const pulled = await readBlob(userId);
    assert.ok(pulled, 'the document that was just written could not be read back');
    assert.equal(pulled.blobVersion, 1);
    assert.equal(canonicalJson(pulled.payload), canonicalJson(payload), 'the document came back reshaped');
  });

  it('answers a pull from an account that has never pushed with null', { skip: !DB_HOST ? 'DB_HOST not set' : false }, async () => {
    const userId = await seedUser('never-pushed');
    // The normal state of a device on its first sign-in, and it must not be an
    // error: the orchestrator starts its first cycle from local state alone.
    assert.equal(await readBlob(userId), null);
  });

  it('refuses a stale push and reports the version to merge against', { skip: !DB_HOST ? 'DB_HOST not set' : false }, async () => {
    const userId = await seedUser('stale');
    const first = sampleEnvelope('first');
    await putBlobIfVersionMatches({ userId, baseVersion: 0, payload: first, sizeBytes: sizeOf(first) });

    // A second device that still believes the document is at version 0.
    const stale = sampleEnvelope('stale-writer');
    const refused = await putBlobIfVersionMatches({
      userId,
      baseVersion: 0,
      payload: stale,
      sizeBytes: sizeOf(stale),
    });

    assert.deepEqual(refused, { status: 'conflict', currentVersion: 1 });

    // And the loser wrote nothing. A conflict that half applied would be worse
    // than one that failed outright.
    const stored = await readBlob(userId);
    assert.equal(canonicalJson(stored?.payload ?? null), canonicalJson(first), 'the stale push overwrote the winner');
  });

  it('lets the loser succeed once it has merged against the current version', { skip: !DB_HOST ? 'DB_HOST not set' : false }, async () => {
    const userId = await seedUser('retry');
    const first = sampleEnvelope('first');
    await putBlobIfVersionMatches({ userId, baseVersion: 0, payload: first, sizeBytes: sizeOf(first) });

    // The client's mandatory recovery loop, in one step: pull, merge, push
    // against the version the conflict named.
    const merged = sampleEnvelope('merged');
    const accepted = await putBlobIfVersionMatches({
      userId,
      baseVersion: 1,
      payload: merged,
      sizeBytes: sizeOf(merged),
    });

    assert.deepEqual(accepted, { status: 'accepted', newVersion: 2 });
    const stored = await readBlob(userId);
    assert.equal(canonicalJson(stored?.payload ?? null), canonicalJson(merged));
  });

  it('keeps one document per account, never two', { skip: !DB_HOST ? 'DB_HOST not set' : false }, async () => {
    const userId = await seedUser('singular');
    const payload = sampleEnvelope('only');
    await putBlobIfVersionMatches({ userId, baseVersion: 0, payload, sizeBytes: sizeOf(payload) });
    await putBlobIfVersionMatches({ userId, baseVersion: 1, payload, sizeBytes: sizeOf(payload) });

    const rows = await db.query.syncBlobs.findMany({ where: (blob, { eq: is }) => is(blob.userId, userId) });
    assert.equal(rows.length, 1, 'a second push created a second row, so a pull is now a coin flip');
  });

  it('refuses a document over the size cap', { skip: !DB_HOST ? 'DB_HOST not set' : false }, async () => {
    const userId = await seedUser('too-large');
    const payload = sampleEnvelope('big');
    const refused = await putBlobIfVersionMatches({
      userId,
      baseVersion: 0,
      payload,
      // The route measures the body it read; a claim over the cap is refused
      // before anything reaches the column.
      sizeBytes: 3 * 1024 * 1024,
    });

    assert.equal(refused.status, 'invalid');
    assert.equal(await readBlob(userId), null, 'an oversized push still wrote a row');
  });

  it('refuses a negative base version rather than computing one', { skip: !DB_HOST ? 'DB_HOST not set' : false }, async () => {
    const userId = await seedUser('negative');
    const payload = sampleEnvelope('negative');
    const refused = await putBlobIfVersionMatches({ userId, baseVersion: -1, payload, sizeBytes: sizeOf(payload) });
    assert.equal(refused.status, 'invalid');
  });
});
