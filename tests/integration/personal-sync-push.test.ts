/**
 * The whole personal-sync push path, end to end against a real Postgres: an
 * offline edit, the blob it eventually becomes, the compare-and-swap that
 * orders two devices, and the promise that the search log never leaves the
 * device.
 *
 * WHAT THIS COVERS
 *   The REAL `runSyncCycleUnlocked` (`app/lib/sync/orchestrator.ts`), the real
 *   envelope (`build-envelope.ts`), the real merge (`snapshot-sync.ts`), the
 *   real outbox, the real `handlePushBlob`/`handlePullBlob`, and the real
 *   `createDrizzleStorageAdapter` against a live database — so the
 *   compare-and-swap is enforced by `sync_blobs_account_version_idx` rather
 *   than by a Map.
 *
 * WHAT THIS DOES NOT COVER, STATED SO NOBODY ASSUMES OTHERWISE
 *   `app/routes/api.v1.sync.blob.ts` is NOT exercised. The gate starts no HTTP
 *   server, so there is no request to carry a session cookie. That route is a
 *   thin wrapper over the two handlers driven below — it decodes base64,
 *   checks `MAX_BLOB_BYTES`, and maps the handler's three results onto
 *   `200`/`409`/`400`. The in-test service below reproduces exactly that
 *   framing, which is why a drift between it and `app/lib/sync/http-client.ts`
 *   shows up here. What is genuinely uncovered is the ONE thing the wrapper
 *   adds: `getAccountSession`, and therefore the `401` path. Read this file as
 *   proof of the sync algorithm and the storage layer, never as proof that the
 *   endpoint is authenticated.
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
 *   carries `ON DELETE CASCADE`, so one delete takes the blobs with it.
 *   Nothing pre-existing is read, written or deleted.
 *
 * WHAT THIS FILE MUST NEVER PRINT
 *   No assertion message may carry a token, an authHash, a passphrase, a DEK
 *   or a wrapped DEK. The DEK below is generated for this run and is only ever
 *   passed as bytes; ciphertext is compared and searched, never interpolated
 *   into a message.
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
import { ENVELOPE_VERSION, MAX_BLOB_BYTES } from '../../app/lib/e2ee/protocol';
import { parseEnvelope } from '../../app/lib/sync/engine/envelope/build-envelope';
import { runSyncCycleUnlocked, type SyncCycleResult } from '../../app/lib/sync/orchestrator';
import { parseRemoteSnapshot } from '../../app/lib/sync/local-store-bridge';
import { createMemoryStorage, createSyncStateStore, type SyncStateStore } from '../../app/lib/sync/sync-state';
import type { PulledBlob, PushResult, SyncHttpClient } from '../../app/lib/sync/http-client';
import {
  BASE_BACKOFF_MS,
  SCHEMA_VERSION,
  createOutboxStore,
  createPrimaryStore,
  enqueueSyncIntent,
  flushOutbox,
  listLocalListItemsIncludingDeleted,
  listLocalListsIncludingDeleted,
  listLocalNotesIncludingDeleted,
  listLocalReviewStateIncludingDeleted,
  listOutboxRecords,
  putLocalList,
  putLocalListItem,
  recordSearch,
  syncedSnapshotSchema,
  writeMergedSnapshot,
  type SyncedSnapshot,
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

/** The account ids this run created. `after()` deletes exactly these; the blobs cascade. */
const createdAccountIds: number[] = [];

/** A fixed instant, so a stamp is an exact expected value rather than a moving one. */
const T0 = 1_760_000_000_000;

// ---------------------------------------------------------------------------
// The wire shapes, transcribed from PROTOCOL.md §5.1 and §5.2
// ---------------------------------------------------------------------------

/** §5.1's request block: `{ "baseVersion": 3, "envelopeVersion": 1, "ciphertext": "<base64>" }`. */
const DOCUMENTED_PUSH_REQUEST_KEYS = ['baseVersion', 'ciphertext', 'envelopeVersion'];
/** §5.1's `200` row: `{"newVersion": 4}`. */
const DOCUMENTED_PUSH_ACCEPTED_KEYS = ['newVersion'];
/** §5.1's `409` row: `{"currentVersion": 5}` — and nothing else, deliberately. */
const DOCUMENTED_PUSH_CONFLICT_KEYS = ['currentVersion'];
/** §5.2's `200` row: `{"blobVersion": 4, "envelopeVersion": 1, "ciphertext": "<base64>", "createdAt": "<iso>"}`. */
const DOCUMENTED_PULL_KEYS = ['blobVersion', 'ciphertext', 'createdAt', 'envelopeVersion'];

/** `POST /blob` request body (§5.1). */
interface PushBlobRequestBody {
  baseVersion: number;
  envelopeVersion: number;
  ciphertext: string;
}

/** `GET /blob` → 200 body (§5.2). */
interface PullBlobResponseBody {
  blobVersion: number;
  envelopeVersion: number;
  ciphertext: string;
  createdAt: string;
}

/** `POST /blob` → 200 body (§5.1). */
interface PushAcceptedBody {
  newVersion: number;
}

/** `POST /blob` → 409 body (§5.1). */
interface PushConflictBody {
  currentVersion: number;
}

/** Any body this file checks against a transcribed key list. */
type DocumentedBody = PushBlobRequestBody | PullBlobResponseBody | PushAcceptedBody | PushConflictBody;

type PushBlobServiceResponse =
  | { status: 200; body: PushAcceptedBody }
  | { status: 409; body: PushConflictBody }
  | { status: 400; body: { error: string } }
  | { status: 413; body: { error: string } };

type PullBlobServiceResponse = { status: 200; body: PullBlobResponseBody } | { status: 404; body: { error: string } };

/**
 * The document is the source and this file is a transcription of it, so every
 * request and response the in-test service handles is checked against the
 * transcribed key list. A body key outside the list is a key the real service
 * does not read.
 */
function assertDocumentedKeys(body: DocumentedBody, documented: readonly string[], label: string): void {
  assert.deepEqual(Object.keys(body).toSorted(), [...documented].toSorted(), `${label} does not match PROTOCOL.md`);
}

/** What the in-test service was asked and what it answered, for the cases to assert against. */
interface BlobCallLog {
  pushRequests: PushBlobRequestBody[];
  pushStatuses: number[];
  pullStatuses: number[];
}

function emptyCallLog(): BlobCallLog {
  return { pushRequests: [], pushStatuses: [], pullStatuses: [] };
}

// ---------------------------------------------------------------------------
// The service, framed exactly as `app/routes/api.v1.sync.blob.ts` frames it
// ---------------------------------------------------------------------------

async function servePullBlob(accountId: number, storage: SyncStorageAdapter): Promise<PullBlobServiceResponse> {
  const result = await handlePullBlob(accountId, storage);
  // §5.2: a 404 is how an account that has never pushed looks.
  if (result.status === 'not-found') return { status: 404, body: { error: 'no blob for this account yet' } };
  return {
    status: 200,
    body: {
      blobVersion: result.blob.blobVersion,
      envelopeVersion: result.blob.envelopeVersion,
      ciphertext: Buffer.from(result.blob.ciphertext).toString('base64'),
      createdAt: result.blob.createdAt.toISOString(),
    },
  };
}

async function servePushBlob(
  accountId: number,
  body: PushBlobRequestBody,
  storage: SyncStorageAdapter,
): Promise<PushBlobServiceResponse> {
  assertDocumentedKeys(body, DOCUMENTED_PUSH_REQUEST_KEYS, 'the POST /blob request body');
  const ciphertext = new Uint8Array(Buffer.from(body.ciphertext, 'base64'));
  if (ciphertext.byteLength > MAX_BLOB_BYTES) {
    return { status: 413, body: { error: `blob exceeds the maximum of ${MAX_BLOB_BYTES} bytes` } };
  }
  const result = await handlePushBlob(
    { accountId, baseVersion: body.baseVersion, envelopeVersion: body.envelopeVersion, ciphertext },
    storage,
  );
  if (result.status === 'accepted') return { status: 200, body: { newVersion: result.newVersion } };
  if (result.status === 'conflict') return { status: 409, body: { currentVersion: result.currentVersion } };
  return { status: 400, body: { error: result.reason } };
}

interface TestClientOptions {
  accountId: number;
  storage: SyncStorageAdapter;
  log: BlobCallLog;
  /**
   * When set, the FIRST pull answers as though the account had never pushed,
   * whatever is actually stored. That is how a stale `baseVersion` is produced
   * without reaching into the orchestrator: the cycle computes `baseVersion: 0`
   * and the compare-and-swap refuses it.
   */
  pretendFirstPullFindsNothing?: boolean;
}

/** The transport the orchestrator drives, over the real handlers and the base64 hop in both directions. */
function createTestSyncHttpClient(options: TestClientOptions): SyncHttpClient {
  let stalePullsLeft = options.pretendFirstPullFindsNothing === true ? 1 : 0;

  return {
    async pullBlob(): Promise<PulledBlob | null> {
      if (stalePullsLeft > 0) {
        stalePullsLeft -= 1;
        options.log.pullStatuses.push(404);
        return null;
      }
      const response = await servePullBlob(options.accountId, options.storage);
      options.log.pullStatuses.push(response.status);
      if (response.status === 404) return null;

      assertDocumentedKeys(response.body, DOCUMENTED_PULL_KEYS, 'the GET /blob 200 body');
      return {
        blobVersion: response.body.blobVersion,
        envelopeVersion: response.body.envelopeVersion,
        ciphertext: new Uint8Array(Buffer.from(response.body.ciphertext, 'base64')),
        createdAt: response.body.createdAt,
      };
    },

    async pushBlob(input): Promise<PushResult> {
      const body: PushBlobRequestBody = {
        baseVersion: input.baseVersion,
        envelopeVersion: input.envelopeVersion,
        ciphertext: Buffer.from(input.ciphertext).toString('base64'),
      };
      options.log.pushRequests.push(body);

      const response = await servePushBlob(options.accountId, body, options.storage);
      options.log.pushStatuses.push(response.status);

      if (response.status === 200) {
        assertDocumentedKeys(response.body, DOCUMENTED_PUSH_ACCEPTED_KEYS, 'the POST /blob 200 body');
        return { status: 'accepted', newVersion: response.body.newVersion };
      }
      if (response.status === 409) {
        assertDocumentedKeys(response.body, DOCUMENTED_PUSH_CONFLICT_KEYS, 'the POST /blob 409 body');
        return { status: 'conflict', currentVersion: response.body.currentVersion };
      }
      throw new Error(`the service refused the push with ${response.status}`);
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
  log: BlobCallLog;
  http: SyncHttpClient;
}

function createDevice(input: {
  accountId: number;
  deviceId: string;
  storage: SyncStorageAdapter;
  pretendFirstPullFindsNothing?: boolean;
}): Device {
  const log = emptyCallLog();
  return {
    store: createPrimaryStore(),
    deviceId: input.deviceId,
    state: createSyncStateStore({ storage: createMemoryStorage(), accountId: input.accountId }),
    log,
    http: createTestSyncHttpClient({
      accountId: input.accountId,
      storage: input.storage,
      log,
      pretendFirstPullFindsNothing: input.pretendFirstPullFindsNothing,
    }),
  };
}

/** The device's synced rows, TOMBSTONES INCLUDED — the same four reads `local-store-bridge.ts` does. */
async function readDeviceSnapshot(device: Device): Promise<SyncedSnapshot> {
  const [lists, listItems, notes, reviewState] = await Promise.all([
    listLocalListsIncludingDeleted({ store: device.store }),
    listLocalListItemsIncludingDeleted({ store: device.store }),
    listLocalNotesIncludingDeleted({ store: device.store }),
    listLocalReviewStateIncludingDeleted({ store: device.store }),
  ]);
  return { lists, listItems, notes, reviewState };
}

/** One full cycle for one device, driving the REAL orchestrator. */
async function runCycle(input: { device: Device; accountId: number; dek: Uint8Array }): Promise<SyncCycleResult> {
  return runSyncCycleUnlocked({
    accountId: input.accountId,
    dek: input.dek,
    http: input.device.http,
    state: input.device.state,
    readSnapshot: () => readDeviceSnapshot(input.device),
    applySnapshot: ({ merged }) => writeMergedSnapshot(merged, { store: input.device.store }),
    parseRemoteSnapshot,
    now: () => T0,
  });
}

// ---------------------------------------------------------------------------
// Database helpers
// ---------------------------------------------------------------------------

/**
 * Creates one account by direct insert and records it for cleanup. The auth
 * flow is not under test here, so the verifier is computed over a throwaway
 * auth-hash with a throwaway pepper rather than routed through signup.
 */
async function createAccount(label: string): Promise<number> {
  const handle = `zzrun-push-${label}-${RUN}-${randomBytes(3).toString('hex')}`;
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

/** Every stored blob for one account, oldest version first. Read straight out of Postgres. */
async function storedBlobs(accountId: number): Promise<{ blobVersion: number; ciphertext: Uint8Array }[]> {
  const rows = await db
    .select({ blobVersion: syncBlobs.blobVersion, ciphertext: syncBlobs.ciphertext })
    .from(syncBlobs)
    .where(eq(syncBlobs.accountId, accountId))
    .orderBy(asc(syncBlobs.blobVersion));
  return rows.map((row) => ({ blobVersion: row.blobVersion, ciphertext: new Uint8Array(row.ciphertext) }));
}

/** The version numbers stored for one account, oldest first. */
async function storedVersions(accountId: number): Promise<number[]> {
  return (await storedBlobs(accountId)).map((blob) => blob.blobVersion);
}

/** Decrypts one stored blob with the run's DEK and the AAD triple PROTOCOL.md §3.2 binds. */
async function decryptStoredBlob(input: {
  accountId: number;
  dek: Uint8Array;
  blob: { blobVersion: number; ciphertext: Uint8Array };
}): Promise<{ snapshot: SyncedSnapshot; serialized: string }> {
  const payload = await parseEnvelope({
    envelope: { envelopeVersion: ENVELOPE_VERSION, ciphertext: input.blob.ciphertext },
    dek: input.dek,
    aadFields: {
      accountId: input.accountId,
      blobVersion: input.blob.blobVersion,
      payloadSchemaVersion: SCHEMA_VERSION,
    },
  });
  return { snapshot: syncedSnapshotSchema.parse(payload.snapshot), serialized: JSON.stringify(payload) };
}

before(async () => {
  if (!DB_HOST) return;
  // Fails loudly here rather than as an obscure error inside the first case.
  await db.select({ id: accounts.id }).from(accounts).limit(1);
});

after(async () => {
  if (DB_HOST && createdAccountIds.length > 0) {
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

describe('an offline edit reaching the account', () => {
  it(
    'is queued while offline, reaches the server on the next flush, and lands as exactly one blob',
    { skip: !DB_HOST ? 'DB_HOST not set' : false },
    async () => {
      const accountId = await createAccount('offline');
      const dek = new Uint8Array(randomBytes(32));
      const storage = createDrizzleStorageAdapter(db);
      const device = createDevice({ accountId, deviceId: 'device-offline', storage });
      const outbox = createOutboxStore();

      // The edit itself. The local store IS the source of truth, so this is
      // already durable before anything reaches the network.
      await putLocalList(
        { id: 'l1', name: 'Reise', languagePair: 'de-en' },
        { store: device.store, deviceId: device.deviceId, now: () => T0 },
      );
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
        { store: device.store, deviceId: device.deviceId, now: () => T0 },
      );
      await enqueueSyncIntent({ clientId: 'intent-1' }, { store: outbox, now: () => T0 });

      const queued = await listOutboxRecords({ store: outbox });
      assert.equal(queued.length, 1, 'the edit did not queue a sync intent');
      assert.equal(queued[0]?.status, 'pending', 'the queued intent is not pending');

      // OFFLINE: the carrier throws, the way a `fetch` does with no network.
      await flushOutbox({
        store: outbox,
        run: () => {
          throw new Error('offline');
        },
        now: () => T0,
      });

      const parked = await listOutboxRecords({ store: outbox });
      assert.equal(parked.length, 1, 'the offline attempt dropped the queued write');
      assert.equal(parked[0]?.status, 'failed', 'the offline attempt did not park the record');
      assert.deepEqual(await storedVersions(accountId), [], 'an offline device wrote a blob');

      // ONLINE. Past the backoff window the failed attempt opened, so the
      // record is selectable again.
      const cycles: SyncCycleResult[] = [];
      const flushed = await flushOutbox({
        store: outbox,
        run: async () => {
          cycles.push(await runCycle({ device, accountId, dek }));
          return { ok: true, status: 200 };
        },
        now: () => T0 + BASE_BACKOFF_MS,
      });

      assert.equal(flushed.flushed, 1, 'the online flush did not confirm the queued write');
      assert.deepEqual(await listOutboxRecords({ store: outbox }), [], 'a confirmed intent stayed in the queue');

      const [result] = cycles;
      assert.ok(result !== undefined, 'the flush never ran a sync cycle');
      assert.equal(result.pushed, true, 'the cycle reported no push');
      assert.equal(result.blobVersion, 1, 'the first push did not land at version 1');
      assert.deepEqual(await storedVersions(accountId), [1], 'the account does not hold exactly one blob at version 1');
    },
  );

  it(
    'moves the version on a second push and stores a second row rather than replacing the first',
    { skip: !DB_HOST ? 'DB_HOST not set' : false },
    async () => {
      const accountId = await createAccount('second');
      const dek = new Uint8Array(randomBytes(32));
      const device = createDevice({ accountId, deviceId: 'device-second', storage: createDrizzleStorageAdapter(db) });

      await putLocalList(
        { id: 'l1', name: 'Reise', languagePair: 'de-en' },
        { store: device.store, deviceId: device.deviceId, now: () => T0 },
      );
      const first = await runCycle({ device, accountId, dek });
      assert.equal(first.blobVersion, 1);

      await putLocalList(
        { id: 'l2', name: 'Arbeit', languagePair: 'de-en' },
        { store: device.store, deviceId: device.deviceId, now: () => T0 },
      );
      const second = await runCycle({ device, accountId, dek });

      assert.equal(second.pushed, true, 'the second cycle did not push');
      assert.equal(second.blobVersion, 2, 'the second push did not land at version 2');
      // `SyncCycleResult` carries no baseVersion, so the compare-and-swap
      // token is read off the request the transport actually sent.
      assert.equal(device.log.pushRequests.at(-1)?.baseVersion, 1, 'the second push did not swap against version 1');
      assert.deepEqual(await storedVersions(accountId), [1, 2], 'the two pushes did not produce two versions');
    },
  );

  it(
    'burns no version when nothing changed, so opening the app is not a write',
    { skip: !DB_HOST ? 'DB_HOST not set' : false },
    async () => {
      const accountId = await createAccount('noop');
      const dek = new Uint8Array(randomBytes(32));
      const device = createDevice({ accountId, deviceId: 'device-noop', storage: createDrizzleStorageAdapter(db) });

      await putLocalList(
        { id: 'l1', name: 'Reise', languagePair: 'de-en' },
        { store: device.store, deviceId: device.deviceId, now: () => T0 },
      );
      const seeded = await runCycle({ device, accountId, dek });
      assert.equal(seeded.pushed, true);
      const versionsBefore = await storedVersions(accountId);

      const idle = await runCycle({ device, accountId, dek });

      assert.equal(idle.pushed, false, 'an unchanged device wrote a new blob');
      assert.equal(idle.blobVersion, seeded.blobVersion, 'an unchanged cycle moved the version');
      assert.deepEqual(await storedVersions(accountId), versionsBefore, 'an unchanged cycle changed what is stored');
    },
  );
});

describe('the 409 recovery loop (PROTOCOL.md §5.1)', () => {
  it(
    'pulls, merges and re-pushes after losing the compare-and-swap, and settles holding both devices data',
    { skip: !DB_HOST ? 'DB_HOST not set' : false },
    async () => {
      const accountId = await createAccount('conflict');
      const dek = new Uint8Array(randomBytes(32));
      const storage = createDrizzleStorageAdapter(db);

      const deviceA = createDevice({ accountId, deviceId: 'device-aaa', storage });
      await putLocalList(
        { id: 'list-from-a', name: 'Reise', languagePair: 'de-en' },
        { store: deviceA.store, deviceId: deviceA.deviceId, now: () => T0 },
      );
      const pushedByA = await runCycle({ device: deviceA, accountId, dek });
      assert.equal(pushedByA.blobVersion, 1, 'device A did not seed version 1');

      // Device B holds a stale view: its first pull answers as though the
      // account had never pushed, so it swaps against version 0 while the
      // stored version is already 1.
      const deviceB = createDevice({
        accountId,
        deviceId: 'device-bbb',
        storage,
        pretendFirstPullFindsNothing: true,
      });
      await putLocalList(
        { id: 'list-from-b', name: 'Arbeit', languagePair: 'de-en' },
        { store: deviceB.store, deviceId: deviceB.deviceId, now: () => T0 },
      );

      const settled = await runCycle({ device: deviceB, accountId, dek });

      assert.ok(deviceB.log.pushStatuses.includes(409), 'device B never lost the compare-and-swap');
      assert.deepEqual(deviceB.log.pushStatuses, [409, 200], 'the recovery loop did not settle on the second attempt');
      assert.deepEqual(
        deviceB.log.pushRequests.map((request) => request.baseVersion),
        [0, 1],
        'the retry did not swap against the version the conflict reported',
      );
      assert.equal(settled.attempts, 2, 'the cycle did not report two compare-and-swap rounds');
      assert.equal(settled.pushed, true);
      assert.equal(settled.blobVersion, 2);

      // AND THE SETTLED BLOB HOLDS BOTH. A recovery loop that "settles" by
      // overwriting the other device is the failure this case exists for.
      const stored = await storedBlobs(accountId);
      const latest = stored.at(-1);
      assert.ok(latest !== undefined, 'the account holds no blob after the recovery loop');
      const decrypted = await decryptStoredBlob({ accountId, dek, blob: latest });
      assert.deepEqual(
        decrypted.snapshot.lists.map((entry) => entry.id).toSorted(),
        ['list-from-a', 'list-from-b'],
        'the merged blob does not hold both devices lists',
      );
    },
  );
});

describe('what a captured blob contains', () => {
  it(
    'holds the lists and none of the search log, read straight out of the ciphertext column',
    { skip: !DB_HOST ? 'DB_HOST not set' : false },
    async () => {
      const accountId = await createAccount('history');
      const dek = new Uint8Array(randomBytes(32));
      const device = createDevice({ accountId, deviceId: 'device-log', storage: createDrizzleStorageAdapter(db) });

      // Queries chosen to be unmistakable in a byte-level search, and to be
      // the kind of thing a person would be alarmed to find on a server.
      const privateQueries = ['zzq-insolvenzberatung', 'zzq-schwangerschaftsabbruch'];
      for (const query of privateQueries) {
        await recordSearch({ query, from: 'de', to: 'en', headwordId: null }, { store: device.store, now: () => T0 });
      }
      await putLocalList(
        { id: 'l1', name: 'Reise', languagePair: 'de-en' },
        { store: device.store, deviceId: device.deviceId, now: () => T0 },
      );

      const cycle = await runCycle({ device, accountId, dek });
      assert.equal(cycle.pushed, true, 'the cycle stored no blob to inspect');

      // STRAIGHT OUT OF POSTGRES, not the value the client held: reading the
      // stored column is what makes this a proof rather than a restatement.
      const stored = await storedBlobs(accountId);
      const latest = stored.at(-1);
      assert.ok(latest !== undefined, 'the account holds no blob');
      const decrypted = await decryptStoredBlob({ accountId, dek, blob: latest });

      assert.deepEqual(decrypted.snapshot.lists.map((entry) => entry.id), ['l1'], 'the stored blob holds no lists');
      for (const query of privateQueries) {
        assert.ok(!decrypted.serialized.includes(query), 'a recorded search reached the stored blob');
      }
      assert.ok(!decrypted.serialized.includes('history'), 'the word history reached the stored blob');
    },
  );
});
