/**
 * A flashcard verdict reaching a second device, against a real Postgres.
 *
 * WHAT THIS COVERS
 *   The REAL write helper (`putLocalReviewState`), the real bridge read
 *   (`readLocalSnapshot`), the real projection, the real orchestrator
 *   (`runSyncCycleUnlocked`), the real envelope, the real merge, the real
 *   `handlePushBlob`/`handlePullBlob`, and the real
 *   `createDrizzleStorageAdapter` against a live database. Two independent
 *   stores stand in for two devices, and what the second one ends up holding is
 *   read out of ITS OWN store rather than out of the value the first one sent.
 *
 *   The reload half is covered by the same mechanism from the other direction:
 *   the local store IS the durable record, so "survives a reload" means "the
 *   row is still there when the store is read again", and the second device's
 *   read below is exactly that read performed by a process that never held the
 *   value in memory.
 *
 * WHAT THIS DOES NOT COVER, STATED SO NOBODY ASSUMES OTHERWISE
 *   `app/routes/api.v1.sync.blob.ts` is NOT exercised, for the reason
 *   `tests/integration/personal-sync-push.test.ts` sets out at length: the gate
 *   starts no HTTP server, so there is no request to carry a session cookie and
 *   the `401` path has no test. The in-test service below frames the two
 *   handlers the way that route frames them, and nothing more.
 *
 *   The browser is not exercised either. `docs/browser-checks.md` records the
 *   headed run over the real screen.
 *
 * THE PRECONDITION IS A REACHABLE DATABASE
 *   `DB_HOST` and the other `DB_*` variables, and nothing else. Every case
 *   gates on `DB_HOST` alone, which `tests/unit/integration-tests-self-skip.test.ts`
 *   counts one-for-one against the cases here.
 *
 * ISOLATION
 *   Every handle carries a run-scoped random suffix, every account created is
 *   recorded, and the cleanup deletes exactly those in a `finally`.
 *   `sync_blobs.account_id` carries `ON DELETE CASCADE`, so one delete takes the
 *   blobs with it. Nothing pre-existing is read, written or deleted.
 *
 * WHAT THIS FILE MUST NEVER PRINT
 *   No assertion message may carry a token, an authHash, a passphrase, a DEK or
 *   a wrapped DEK. The DEK below is generated for this run and only ever passed
 *   as bytes.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { asc, eq, inArray } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import type { Store } from 'tinybase';

import * as schema from '../../drizzle/schema';
import { closePool } from '../../drizzle/db';
import { accounts, syncBlobs } from '../../drizzle/schema';
import type { SyncStorageAdapter } from '../../app/lib/e2ee/contract-types';
import { handlePullBlob } from '../../app/lib/e2ee/pull-handler';
import { handlePushBlob } from '../../app/lib/e2ee/push-handler';
import { createDrizzleStorageAdapter } from '../../app/services/e2ee-storage-adapter.server';
import { DEFAULT_ARGON2_PARAMS } from '../../app/lib/e2ee/kdf-descriptor';
import { computeVerifier } from '../../app/lib/e2ee/verifier';
import { ENVELOPE_VERSION } from '../../app/lib/e2ee/protocol';
import { parseEnvelope } from '../../app/lib/sync/engine/envelope/build-envelope';
import { runSyncCycleUnlocked, type SyncCycleResult } from '../../app/lib/sync/orchestrator';
import { parseRemoteSnapshot, readLocalSnapshot } from '../../app/lib/sync/local-store-bridge';
import { createMemoryStorage, createSyncStateStore, type SyncStateStore } from '../../app/lib/sync/sync-state';
import type { PulledBlob, PushResult, SyncHttpClient } from '../../app/lib/sync/http-client';
import {
  SCHEMA_VERSION,
  createPrimaryStore,
  listLocalReviewState,
  putLocalList,
  putLocalListItem,
  putLocalReviewState,
  syncedSnapshotSchema,
  writeMergedSnapshot,
} from '../../app/lib/local-store';

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

/** The account ids this run created. The cleanup deletes exactly these; the blobs cascade. */
const createdAccountIds: number[] = [];

/** A fixed instant, so a stamp is an exact expected value rather than a moving one. */
const T0 = 1_760_000_000_000;

// ---------------------------------------------------------------------------
// The service, framed exactly as `app/routes/api.v1.sync.blob.ts` frames it
// ---------------------------------------------------------------------------

/** The transport the orchestrator drives, over the real handlers and the base64 hop in both directions. */
function createTestSyncHttpClient({
  accountId,
  storage,
}: {
  accountId: number;
  storage: SyncStorageAdapter;
}): SyncHttpClient {
  return {
    async pullBlob(): Promise<PulledBlob | null> {
      const result = await handlePullBlob(accountId, storage);
      // A 404 is how an account that has never pushed looks (PROTOCOL.md §5.2).
      if (result.status === 'not-found') return null;
      // Through base64 in both directions, because that is what the route does
      // and a byte lost in that hop would not show up any other way.
      const ciphertext = Buffer.from(result.blob.ciphertext).toString('base64');
      return {
        blobVersion: result.blob.blobVersion,
        envelopeVersion: result.blob.envelopeVersion,
        ciphertext: new Uint8Array(Buffer.from(ciphertext, 'base64')),
        createdAt: result.blob.createdAt.toISOString(),
      };
    },

    async pushBlob(input): Promise<PushResult> {
      const ciphertext = new Uint8Array(Buffer.from(Buffer.from(input.ciphertext).toString('base64'), 'base64'));
      const result = await handlePushBlob(
        { accountId, baseVersion: input.baseVersion, envelopeVersion: input.envelopeVersion, ciphertext },
        storage,
      );
      if (result.status === 'accepted') return { status: 'accepted', newVersion: result.newVersion };
      if (result.status === 'conflict') return { status: 'conflict', currentVersion: result.currentVersion };
      throw new Error(`the service refused the push: ${result.reason}`);
    },
  };
}

// ---------------------------------------------------------------------------
// A device: its own primary store, its own device id, its own sync state
// ---------------------------------------------------------------------------

interface Device {
  store: Store;
  deviceId: string;
  state: SyncStateStore;
  http: SyncHttpClient;
}

function createDevice({
  accountId,
  deviceId,
  storage,
}: {
  accountId: number;
  deviceId: string;
  storage: SyncStorageAdapter;
}): Device {
  return {
    store: createPrimaryStore(),
    deviceId,
    state: createSyncStateStore({ storage: createMemoryStorage(), accountId }),
    http: createTestSyncHttpClient({ accountId, storage }),
  };
}

/**
 * One full cycle for one device, driving the REAL orchestrator over the REAL
 * bridge read. `readLocalSnapshot` is the function the app itself calls, so a
 * collection missing from it is missing here too.
 */
async function runCycle({
  device,
  accountId,
  dek,
}: {
  device: Device;
  accountId: number;
  dek: Uint8Array;
}): Promise<SyncCycleResult> {
  return runSyncCycleUnlocked({
    accountId,
    dek,
    http: device.http,
    state: device.state,
    readSnapshot: () => readLocalSnapshot({ store: device.store }),
    applySnapshot: ({ merged }) => writeMergedSnapshot(merged, { store: device.store }),
    parseRemoteSnapshot,
    now: () => T0,
  });
}

// ---------------------------------------------------------------------------
// Database helpers
// ---------------------------------------------------------------------------

/** Creates one account by direct insert and records it for cleanup. The auth flow is not under test here. */
async function createAccount(label: string): Promise<number> {
  const handle = `zzrun-review-${label}-${RUN}-${randomBytes(3).toString('hex')}`;
  const [row] = await db
    .insert(accounts)
    .values({
      handle,
      verifier: computeVerifier({ authHash: randomBytes(32).toString('base64'), pepper: `test-pepper-${RUN}` }),
      kdfDescriptor: { salt: randomBytes(16).toString('base64'), params: { ...DEFAULT_ARGON2_PARAMS } },
    })
    .returning({ id: accounts.id });

  assert.ok(row, 'the account row was not written');
  createdAccountIds.push(row.id);
  return row.id;
}

/** Every stored blob for one account, oldest version first. Read straight out of Postgres. */
async function storedBlobs(accountId: number): Promise<{ blobVersion: number; ciphertext: Uint8Array }[]> {
  const rows = await db
    .select({ blobVersion: syncBlobs.blobVersion, ciphertext: syncBlobs.ciphertext })
    .from(syncBlobs)
    .where(eq(syncBlobs.accountId, accountId))
    .orderBy(asc(syncBlobs.blobVersion));
  return rows.map((row) => ({ blobVersion: row.blobVersion, ciphertext: new Uint8Array(row.ciphertext) }));
}

/** Decrypts one stored blob with the run's DEK and the AAD triple PROTOCOL.md §3.2 binds. */
async function decryptLatestBlob({
  accountId,
  dek,
}: {
  accountId: number;
  dek: Uint8Array;
}): Promise<{ reviewState: { id: string; gotItCount: number; stillLearningCount: number }[]; serialized: string }> {
  const latest = (await storedBlobs(accountId)).at(-1);
  assert.ok(latest !== undefined, 'the account holds no blob to read');
  const payload = await parseEnvelope({
    envelope: { envelopeVersion: ENVELOPE_VERSION, ciphertext: latest.ciphertext },
    dek,
    aadFields: { accountId, blobVersion: latest.blobVersion, payloadSchemaVersion: SCHEMA_VERSION },
  });
  return { reviewState: syncedSnapshotSchema.parse(payload.snapshot).reviewState, serialized: JSON.stringify(payload) };
}

/** One saved word, so a review state has something to be about. */
async function seedWord(device: Device): Promise<void> {
  const options = { store: device.store, deviceId: device.deviceId, now: () => T0 };
  await putLocalList({ id: 'l1', name: 'Reise', languagePair: 'de-en' }, options);
  await putLocalListItem(
    {
      id: 'i1',
      listId: 'l1',
      headwordId: 'hw-1',
      senseId: null,
      lemma: 'Fahrkarte',
      translationSnapshot: 'ticket',
      note: '',
    },
    options,
  );
}

before(async () => {
  if (!DB_HOST) return;
  // Fails loudly here rather than as an obscure error inside the first case.
  await db.select({ id: accounts.id }).from(accounts).limit(1);
});

after(async () => {
  try {
    if (DB_HOST && createdAccountIds.length > 0) {
      await db.delete(accounts).where(inArray(accounts.id, createdAccountIds));
    }
  } finally {
    await pool.end();
    // AND THE APP'S OWN POOL, which this file never asked for.
    // `e2ee-storage-adapter.server.ts` imports `#drizzle/db`, which
    // opens a pool AT MODULE LOAD. It is never queried here, but `node --test`
    // sets no timeout, so leaving it open makes the run never end.
    await closePool();
  }
});

describe('a flashcard verdict reaching a second device', () => {
  it(
    'rides the encrypted blob and is readable in the second device’s own store',
    { skip: !DB_HOST ? 'DB_HOST not set' : false },
    async () => {
      const accountId = await createAccount('two-devices');
      const dek = new Uint8Array(randomBytes(32));
      const storage = createDrizzleStorageAdapter(db);

      const phone = createDevice({ accountId, deviceId: 'device-phone', storage });
      await seedWord(phone);
      // The verdicts a session would record: two got-it, one still-learning.
      await putLocalReviewState(
        { id: 'i1', gotItCount: 2, stillLearningCount: 1, lastReviewedAt: T0 },
        { store: phone.store, deviceId: phone.deviceId, now: () => T0 },
      );

      const pushed = await runCycle({ device: phone, accountId, dek });
      assert.equal(pushed.pushed, true, 'the phone stored no blob to inherit');

      // STRAIGHT OUT OF POSTGRES: the ciphertext column, not the value the
      // client held, is what makes this a proof rather than a restatement.
      const stored = await decryptLatestBlob({ accountId, dek });
      assert.deepEqual(
        stored.reviewState.map((state) => [state.id, state.gotItCount, state.stillLearningCount]),
        [['i1', 2, 1]],
        'the review tally did not reach the stored blob',
      );

      // A SECOND DEVICE, with an empty store of its own. It pulls, merges and
      // writes, and the assertion below reads ITS store rather than the
      // snapshot the cycle returned.
      const laptop = createDevice({ accountId, deviceId: 'device-laptop', storage });
      await runCycle({ device: laptop, accountId, dek });

      const inherited = await listLocalReviewState({ store: laptop.store });
      assert.equal(inherited.length, 1, 'the second device did not inherit the review state');
      const [state] = inherited;
      assert.ok(state !== undefined);
      assert.equal(state.id, 'i1', 'the review state is not keyed by the list entry it belongs to');
      assert.equal(state.gotItCount, 2);
      assert.equal(state.stillLearningCount, 1);
      // The peer's stamp is ADOPTED, not re-issued. Re-stamping here would make
      // the laptop claim the phone's write and the two would never converge.
      assert.equal(state.deviceId, phone.deviceId, 'the second device re-stamped a row it merely adopted');
    },
  );

  it(
    'lets a later session on the second device win by lamport, and the first device adopt it back',
    { skip: !DB_HOST ? 'DB_HOST not set' : false },
    async () => {
      const accountId = await createAccount('lamport');
      const dek = new Uint8Array(randomBytes(32));
      const storage = createDrizzleStorageAdapter(db);

      const phone = createDevice({ accountId, deviceId: 'device-phone', storage });
      await seedWord(phone);
      await putLocalReviewState(
        { id: 'i1', gotItCount: 1, stillLearningCount: 0, lastReviewedAt: T0 },
        { store: phone.store, deviceId: phone.deviceId, now: () => T0 },
      );
      await runCycle({ device: phone, accountId, dek });

      const laptop = createDevice({ accountId, deviceId: 'device-laptop', storage });
      await runCycle({ device: laptop, accountId, dek });
      const adopted = (await listLocalReviewState({ store: laptop.store })).at(0);
      assert.ok(adopted !== undefined, 'the second device inherited nothing to build on');

      // A session on the laptop. `putLocalReviewState` bumps the lamport off
      // the row it just adopted, which is what lets it outrank the phone.
      await putLocalReviewState(
        { id: 'i1', gotItCount: 1, stillLearningCount: 4, lastReviewedAt: T0 + 1000 },
        { store: laptop.store, deviceId: laptop.deviceId, now: () => T0 + 1000 },
      );
      const laptopWrote = (await listLocalReviewState({ store: laptop.store })).at(0);
      assert.ok(laptopWrote !== undefined);
      assert.ok(
        laptopWrote.lamport > adopted.lamport,
        'the local write did not outrank the row it was built on, so the merge below would be undecided',
      );

      await runCycle({ device: laptop, accountId, dek });

      // The phone pulls and must ADOPT the higher stamp, not keep its own.
      await runCycle({ device: phone, accountId, dek });
      const onPhone = (await listLocalReviewState({ store: phone.store })).at(0);
      assert.ok(onPhone !== undefined, 'the first device lost its review state in the merge');
      assert.equal(onPhone.stillLearningCount, 4, 'the higher-lamport tally did not win on the first device');
      assert.equal(onPhone.deviceId, laptop.deviceId, 'the winning row did not carry the writing device’s id');
    },
  );

  it(
    'keeps the search log out of the blob it now also carries review state in',
    { skip: !DB_HOST ? 'DB_HOST not set' : false },
    async () => {
      const accountId = await createAccount('no-log');
      const dek = new Uint8Array(randomBytes(32));
      const device = createDevice({ accountId, deviceId: 'device-phone', storage: createDrizzleStorageAdapter(db) });

      await seedWord(device);
      await putLocalReviewState(
        { id: 'i1', gotItCount: 3, stillLearningCount: 2, lastReviewedAt: T0 },
        { store: device.store, deviceId: device.deviceId, now: () => T0 },
      );
      await runCycle({ device, accountId, dek });

      const stored = await decryptLatestBlob({ accountId, dek });

      // The check is not vacuous: the new collection DID make the trip through
      // the same serialization the absent one is checked against.
      assert.equal(stored.reviewState.length, 1, 'the blob carried no review state, so the check below proves nothing');
      assert.ok(!stored.serialized.includes('history'), 'the word history reached the stored blob');
    },
  );
});
