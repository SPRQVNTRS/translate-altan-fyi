/**
 * The blob compare-and-swap, proven against a real Postgres and the REAL
 * Drizzle storage adapter (PROTOCOL.md §5.1 and §5.2).
 *
 * WHY THIS CANNOT BE A UNIT TEST
 *   `tests/unit/e2ee/blob-handlers.test.ts` already covers the handler policy
 *   against an in-memory fake, and that fake resolves a conflict by comparing
 *   two numbers in a Map. Nothing about that is a race: JavaScript gave it
 *   atomicity for free. The property that actually protects a user's data is
 *   the one only Postgres can provide — `sync_blobs_account_version_idx`,
 *   the UNIQUE index on `(account_id, blob_version)`. Two devices holding the
 *   same version can BOTH read it, both compute the same `newVersion`, and
 *   both attempt the insert. Exactly one can succeed; the loser takes a 23505
 *   unique violation which `app/services/e2ee-storage-adapter.server.ts`
 *   translates into the same conflict a plain version mismatch returns.
 *
 *   A fake store passes that by construction. This file fires the two pushes
 *   concurrently and asserts the outcome, so the index is load-bearing rather
 *   than decorative.
 *
 * THE PRECONDITION IS A REACHABLE DATABASE
 *   `DB_HOST` and the other `DB_*` variables, and nothing else: no API key and
 *   no server on :3456. Every case gates on `DB_HOST` alone. See
 *   `tests/unit/integration-tests-self-skip.test.ts`, which counts cases
 *   against skip guards and fails the unit tier if they do not match
 *   one-for-one.
 *
 * ISOLATION
 *   Every handle carries a run-scoped random suffix, every account created is
 *   recorded, and `after()` deletes exactly those. `sync_blobs.account_id`
 *   carries `ON DELETE CASCADE`, so one delete takes the blobs with it — the
 *   same mechanism the self-serve erasure path relies on. Nothing pre-existing
 *   is read, written or deleted.
 *
 * WHAT THIS FILE MUST NEVER PRINT
 *   No assertion message may carry a raw token, an authHash, a passphrase or a
 *   wrapped DEK. Ciphertext is compared by base64 digest-free equality inside
 *   the assertion, never interpolated into a message.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';

import * as schema from '../../drizzle/schema';
import { closePool } from '../../drizzle/db';
import { accounts, syncBlobs } from '../../drizzle/schema';
import type { SyncStorageAdapter } from '../../app/lib/e2ee/contract-types';
import { handlePullBlob } from '../../app/lib/e2ee/pull-handler';
import { handlePushBlob } from '../../app/lib/e2ee/push-handler';
import { createDrizzleStorageAdapter } from '../../app/services/e2ee-storage-adapter.server';
import { DEFAULT_ARGON2_PARAMS } from '../../app/lib/e2ee/kdf-descriptor';
import { computeVerifier } from '../../app/lib/e2ee/verifier';

const DB_HOST = process.env.DB_HOST;

const pool = new pg.Pool({
  host: DB_HOST,
  port: Number(process.env.DB_PORT ?? 5432),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
});

const db = drizzle(pool, { schema });

/** Every handle this run creates carries this suffix, so cleanup can be exact. */
const RUN = randomUUID().slice(0, 8);

/** The account ids this run created. `after()` deletes exactly these; the blobs cascade. */
const createdAccountIds: number[] = [];

const ENVELOPE_VERSION = 1;

/**
 * Opaque ciphertext. The service stores and returns these bytes verbatim and
 * never parses them, so random bytes are a faithful payload.
 */
function ciphertext(): Uint8Array {
  return new Uint8Array(randomBytes(96));
}

function asBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

/**
 * Creates one account by direct insert and records it for cleanup. The auth
 * flow is not under test here, so the verifier is computed over a throwaway
 * auth-hash with a throwaway pepper rather than routed through signup.
 */
async function createAccount(label: string): Promise<number> {
  const handle = `zzrun-blob-${label}-${RUN}-${randomBytes(3).toString('hex')}`;
  const [row] = await db
    .insert(accounts)
    .values({
      handle,
      verifier: computeVerifier({
        authHash: randomBytes(32).toString('base64'),
        pepper: `test-pepper-${RUN}`,
      }),
      kdfDescriptor: {
        salt: randomBytes(16).toString('base64'),
        params: { ...DEFAULT_ARGON2_PARAMS },
      },
    })
    .returning({ id: accounts.id });

  assert.ok(row, 'the account row was not written');
  createdAccountIds.push(row.id);
  return row.id;
}

/** Pushes one blob and returns the version it landed at, failing loudly if it did not land. */
async function pushAccepted(input: {
  accountId: number;
  baseVersion: number;
  payload: Uint8Array;
  storage: SyncStorageAdapter;
}): Promise<number> {
  const result = await handlePushBlob(
    {
      accountId: input.accountId,
      baseVersion: input.baseVersion,
      envelopeVersion: ENVELOPE_VERSION,
      ciphertext: input.payload,
    },
    input.storage,
  );
  assert.equal(result.status, 'accepted', `a push at baseVersion ${input.baseVersion} was not accepted`);
  if (result.status !== 'accepted') throw new Error('unreachable');
  return result.newVersion;
}

/** Every stored ciphertext for one account at one version, as base64. */
async function storedVersions(accountId: number, blobVersion: number): Promise<string[]> {
  const rows = await db
    .select({ ciphertext: syncBlobs.ciphertext })
    .from(syncBlobs)
    .where(and(eq(syncBlobs.accountId, accountId), eq(syncBlobs.blobVersion, blobVersion)));
  return rows.map((row) => Buffer.from(row.ciphertext).toString('base64'));
}

before(async () => {
  if (!DB_HOST) return;
  // Fails loudly here rather than as an obscure error inside the first case.
  await db.select({ id: accounts.id }).from(accounts).limit(1);
});

after(async () => {
  if (DB_HOST && createdAccountIds.length > 0) {
    // ONE delete. `sync_blobs.account_id` carries `ON DELETE CASCADE`, which is
    // the same mechanism the self-serve erasure path relies on, so cleaning up
    // this way exercises it.
    await db.delete(accounts).where(inArray(accounts.id, createdAccountIds));
  }
  await pool.end();

  // AND THE APP'S OWN POOL, which this file never asked for.
  // `e2ee-storage-adapter.server.ts` imports `#drizzle/tenant-db`, which opens
  // a connection pool AT MODULE LOAD. The adapter under test is constructed
  // with the local `db` above, so that pool is never queried — but it is open,
  // and `node --test` sets no timeout, so leaving it behind does not fail the
  // run: it makes the run never end.
  await closePool();
});

describe('the blob compare-and-swap, against a real database', () => {
  it(
    'two devices racing the same version produce exactly one accepted push and one conflict',
    { skip: !DB_HOST ? 'DB_HOST not set' : false },
    async () => {
      const accountId = await createAccount('race');
      const storage = createDrizzleStorageAdapter(db);

      // Start at version 1 rather than 0, so the race is over an EXISTING
      // version and the losing insert is refused by the unique index rather
      // than by an empty-table read.
      const baseVersion = await pushAccepted({ accountId, baseVersion: 0, payload: ciphertext(), storage });
      assert.equal(baseVersion, 1, 'the seed push did not land at version 1');

      const deviceA = ciphertext();
      const deviceB = ciphertext();
      assert.notEqual(asBase64(deviceA), asBase64(deviceB), 'the two devices pushed identical bytes');

      const [resultA, resultB] = await Promise.all([
        handlePushBlob(
          { accountId, baseVersion, envelopeVersion: ENVELOPE_VERSION, ciphertext: deviceA },
          storage,
        ),
        handlePushBlob(
          { accountId, baseVersion, envelopeVersion: ENVELOPE_VERSION, ciphertext: deviceB },
          storage,
        ),
      ]);

      const outcomes = [resultA.status, resultB.status].toSorted();
      assert.deepEqual(outcomes, ['accepted', 'conflict'], 'the race did not resolve to one winner and one loser');

      const winner = resultA.status === 'accepted' ? { result: resultA, payload: deviceA } : { result: resultB, payload: deviceB };
      const loser = resultA.status === 'accepted' ? resultB : resultA;
      if (winner.result.status !== 'accepted' || loser.status !== 'conflict') throw new Error('unreachable');

      assert.equal(winner.result.newVersion, baseVersion + 1, 'the winner did not advance the version by one');
      assert.equal(
        loser.currentVersion,
        winner.result.newVersion,
        'the conflict did not report the version the winner wrote',
      );

      // AND ONLY THE WINNER IS STORED. One row at the contested version, and
      // it holds the winner's bytes: the loser neither overwrote it nor landed
      // a second row beside it.
      const stored = await storedVersions(accountId, winner.result.newVersion);
      assert.equal(stored.length, 1, 'the contested version does not hold exactly one row');
      assert.equal(stored[0], asBase64(winner.payload), 'the stored bytes are not the ones the winning device pushed');
    },
  );

  it(
    'the loser recovers by pulling the winning blob and pushing against the version it read',
    { skip: !DB_HOST ? 'DB_HOST not set' : false },
    async () => {
      const accountId = await createAccount('recover');
      const storage = createDrizzleStorageAdapter(db);

      const baseVersion = await pushAccepted({ accountId, baseVersion: 0, payload: ciphertext(), storage });
      const deviceA = ciphertext();
      const deviceB = ciphertext();

      const [resultA, resultB] = await Promise.all([
        handlePushBlob(
          { accountId, baseVersion, envelopeVersion: ENVELOPE_VERSION, ciphertext: deviceA },
          storage,
        ),
        handlePushBlob(
          { accountId, baseVersion, envelopeVersion: ENVELOPE_VERSION, ciphertext: deviceB },
          storage,
        ),
      ]);
      assert.deepEqual(
        [resultA.status, resultB.status].toSorted(),
        ['accepted', 'conflict'],
        'the race did not resolve to one winner and one loser',
      );
      const winningPayload = resultA.status === 'accepted' ? deviceA : deviceB;

      // THE RECOVERY LOOP THE PROTOCOL PRESCRIBES. The conflict body carries a
      // version and nothing else, so the losing device pulls, merges locally,
      // and pushes against the version it just read.
      const pulled = await handlePullBlob(accountId, storage);
      assert.equal(pulled.status, 'found', 'the losing device could not pull after its conflict');
      if (pulled.status !== 'found') throw new Error('unreachable');
      assert.equal(
        asBase64(pulled.blob.ciphertext),
        asBase64(winningPayload),
        'the pull returned bytes other than the ones the winner pushed',
      );
      assert.equal(pulled.blob.blobVersion, baseVersion + 1, 'the pull reported a version other than the one the winner wrote');

      const merged = ciphertext();
      const newVersion = await pushAccepted({
        accountId,
        baseVersion: pulled.blob.blobVersion,
        payload: merged,
        storage,
      });
      assert.equal(newVersion, baseVersion + 2, 'the retry did not land at the next version');

      const stored = await storedVersions(accountId, newVersion);
      assert.deepEqual(stored, [asBase64(merged)], 'the retry did not store the merged blob');
    },
  );

  it(
    'a pull for an account that has never pushed is not-found',
    { skip: !DB_HOST ? 'DB_HOST not set' : false },
    async () => {
      const accountId = await createAccount('fresh');
      const storage = createDrizzleStorageAdapter(db);

      // PROTOCOL.md §5.2: this is not an error condition, it is what a fresh
      // account looks like on its first pull.
      const result = await handlePullBlob(accountId, storage);

      assert.equal(result.status, 'not-found', 'an account that never pushed returned a blob');
    },
  );

  it(
    'a stale baseVersion is refused with the real current version, and the stored bytes are unchanged',
    { skip: !DB_HOST ? 'DB_HOST not set' : false },
    async () => {
      const accountId = await createAccount('stale');
      const storage = createDrizzleStorageAdapter(db);

      const kept = ciphertext();
      const currentVersion = await pushAccepted({ accountId, baseVersion: 0, payload: kept, storage });

      // A device that never saw the write above. Accepting this would discard
      // the other device's changes with nothing to indicate it happened.
      const stale = await handlePushBlob(
        { accountId, baseVersion: 0, envelopeVersion: ENVELOPE_VERSION, ciphertext: ciphertext() },
        storage,
      );

      assert.equal(stale.status, 'conflict', 'a stale push was accepted');
      if (stale.status !== 'conflict') throw new Error('unreachable');
      assert.equal(stale.currentVersion, currentVersion, 'the conflict did not report the real current version');

      const stored = await storedVersions(accountId, currentVersion);
      assert.deepEqual(stored, [asBase64(kept)], 'the refused push changed the stored blob');

      const [nextVersion] = await storedVersions(accountId, currentVersion + 1);
      assert.equal(nextVersion, undefined, 'the refused push wrote a new version');
    },
  );
});
