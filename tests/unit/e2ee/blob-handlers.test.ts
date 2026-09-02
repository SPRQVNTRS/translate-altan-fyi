/**
 * `handlePushBlob` and `handlePullBlob` against the in-memory fake adapter
 * (PROTOCOL.md §5.1 and §5.2).
 *
 * THE CLAIM THIS FILE EXISTS TO MECHANISE. PROTOCOL.md §10.5 says the service
 * stores and returns the ciphertext verbatim: it never decrypts it, never
 * gunzips it and never JSON-parses it. Reading the handlers and seeing no
 * `JSON.parse` is not a check — it is a code review that decays the moment
 * somebody adds a "harmless" size-estimating parse.
 *
 * So the payload here is 64 bytes that THROW when parsed as JSON and THROW
 * when gunzipped, and the test asserts that first, before using them. Any
 * inspection added to the push path would raise rather than return a typed
 * result, and any re-encoding would show up as a byte difference in the
 * recording adapter below. The property is then checked from both ends: the
 * bytes the storage adapter was handed, and the bytes a pull hands back.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { gunzipSync } from 'node:zlib';

import type { PutBlobResult, SyncStorageAdapter } from '#app/lib/e2ee/contract-types';
import { handlePullBlob } from '#app/lib/e2ee/pull-handler';
import { handlePushBlob } from '#app/lib/e2ee/push-handler';
import { createFakeStorageAdapter } from './fake-storage-adapter';

const ACCOUNT_ID = 1;
const ENVELOPE_VERSION = 1;

/** What the adapter was handed, captured at the moment of the call. */
interface RecordedPush {
  /** The exact object the handler passed, so reference identity is checkable. */
  received: Uint8Array;
  /** A copy taken at call time, so a later mutation cannot repair a mismatch. */
  snapshot: Uint8Array;
}

interface RecordingStorage {
  storage: SyncStorageAdapter;
  pushes: RecordedPush[];
}

/**
 * Wraps the fake adapter and records every ciphertext the push path hands
 * down. The wrapper delegates; it deliberately changes no behaviour, so the
 * conflict and version semantics under test stay the fake's.
 */
function createRecordingStorage(): RecordingStorage {
  const inner = createFakeStorageAdapter();
  const pushes: RecordedPush[] = [];

  return {
    pushes,
    storage: {
      ...inner,
      async putBlobIfVersionMatches(input): Promise<PutBlobResult> {
        pushes.push({ received: input.ciphertext, snapshot: Uint8Array.from(input.ciphertext) });
        return inner.putBlobIfVersionMatches(input);
      },
    },
  };
}

/**
 * 64 random bytes that are neither gzip nor JSON. The first two bytes are
 * pinned away from the gzip magic (`1f 8b`) and onto a leading NUL, which no
 * JSON document may start with, so the "would throw" property is guaranteed
 * rather than probable.
 */
function opaqueCiphertext(): Uint8Array {
  const bytes = new Uint8Array(randomBytes(64));
  bytes[0] = 0x00;
  bytes[1] = 0xff;
  return bytes;
}

test('the push payload is genuinely unparseable, so the byte-equality tests below are load-bearing', () => {
  const payload = opaqueCiphertext();

  assert.throws(
    () => JSON.parse(Buffer.from(payload).toString('latin1')),
    Error,
    'the fixture parses as JSON, so a server-side parse would go unnoticed',
  );
  assert.throws(
    () => gunzipSync(Buffer.from(payload)),
    Error,
    'the fixture gunzips, so a server-side decompress would go unnoticed',
  );
});

test('a push then a pull round-trips the ciphertext byte for byte, and the adapter got exactly those bytes', async () => {
  const { storage, pushes } = createRecordingStorage();
  const payload = opaqueCiphertext();

  const pushed = await handlePushBlob(
    { accountId: ACCOUNT_ID, baseVersion: 0, envelopeVersion: ENVELOPE_VERSION, ciphertext: payload },
    storage,
  );
  assert.equal(pushed.status, 'accepted', 'a first push of a well-formed blob was refused');

  // WHAT THE SERVER WAS HANDED. Not a re-encoding, not a normalised copy, not
  // a truncation: the caller's bytes.
  assert.equal(pushes.length, 1, 'the push path did not reach storage exactly once');
  const record = pushes[0];
  assert.ok(record, 'no push was recorded');
  assert.equal(record.snapshot.byteLength, payload.byteLength, 'the stored blob changed length on the way down');
  assert.deepEqual(record.snapshot, payload, 'the bytes handed to storage differ from the bytes the caller pushed');
  assert.equal(record.received, payload, 'the push path substituted a different buffer for the one the caller passed');

  // AND WHAT COMES BACK OUT.
  const pulled = await handlePullBlob(ACCOUNT_ID, storage);
  assert.equal(pulled.status, 'found', 'a blob that was just accepted could not be pulled');
  if (pulled.status !== 'found') throw new Error('unreachable');
  assert.equal(pulled.blob.ciphertext.byteLength, payload.byteLength, 'the pulled blob changed length');
  assert.deepEqual(pulled.blob.ciphertext, payload, 'the pulled bytes differ from the pushed bytes');
  assert.equal(pulled.blob.envelopeVersion, ENVELOPE_VERSION, 'the envelope version was not preserved');
});

test('a negative baseVersion is invalid, with the reason the handler defines', async () => {
  const storage = createFakeStorageAdapter();
  const result = await handlePushBlob(
    { accountId: ACCOUNT_ID, baseVersion: -1, envelopeVersion: ENVELOPE_VERSION, ciphertext: opaqueCiphertext() },
    storage,
  );

  assert.equal(result.status, 'invalid');
  if (result.status !== 'invalid') throw new Error('unreachable');
  assert.equal(result.reason, 'baseVersion must be a non-negative integer');
  assert.equal(await handlePullBlob(ACCOUNT_ID, storage).then((pull) => pull.status), 'not-found');
});

test('a non-integer baseVersion is invalid', async () => {
  const storage = createFakeStorageAdapter();
  const result = await handlePushBlob(
    { accountId: ACCOUNT_ID, baseVersion: 1.5, envelopeVersion: ENVELOPE_VERSION, ciphertext: opaqueCiphertext() },
    storage,
  );

  assert.equal(result.status, 'invalid');
  if (result.status !== 'invalid') throw new Error('unreachable');
  assert.equal(result.reason, 'baseVersion must be a non-negative integer');
});

test('a non-positive envelopeVersion is invalid', async () => {
  const storage = createFakeStorageAdapter();
  const result = await handlePushBlob(
    { accountId: ACCOUNT_ID, baseVersion: 0, envelopeVersion: 0, ciphertext: opaqueCiphertext() },
    storage,
  );

  assert.equal(result.status, 'invalid');
  if (result.status !== 'invalid') throw new Error('unreachable');
  assert.equal(result.reason, 'envelopeVersion must be a positive integer');
});

test('an empty ciphertext is invalid', async () => {
  const storage = createFakeStorageAdapter();
  const result = await handlePushBlob(
    { accountId: ACCOUNT_ID, baseVersion: 0, envelopeVersion: ENVELOPE_VERSION, ciphertext: new Uint8Array(0) },
    storage,
  );

  assert.equal(result.status, 'invalid');
  if (result.status !== 'invalid') throw new Error('unreachable');
  assert.equal(result.reason, 'ciphertext must not be empty');
});

test('baseVersion 0 asserts "no blob yet", and the first accepted push is version 1', async () => {
  const storage = createFakeStorageAdapter();

  const result = await handlePushBlob(
    { accountId: ACCOUNT_ID, baseVersion: 0, envelopeVersion: ENVELOPE_VERSION, ciphertext: opaqueCiphertext() },
    storage,
  );

  assert.equal(result.status, 'accepted');
  if (result.status !== 'accepted') throw new Error('unreachable');
  assert.equal(result.newVersion, 1, 'the first accepted push did not land at version 1');
});

test('a stale baseVersion after a successful push conflicts and reports the real current version', async () => {
  const storage = createFakeStorageAdapter();
  const winner = opaqueCiphertext();

  const accepted = await handlePushBlob(
    { accountId: ACCOUNT_ID, baseVersion: 0, envelopeVersion: ENVELOPE_VERSION, ciphertext: winner },
    storage,
  );
  assert.equal(accepted.status, 'accepted');

  // A second device still holding version 0. Accepting this would discard the
  // write above without either device ever learning of it.
  const stale = await handlePushBlob(
    { accountId: ACCOUNT_ID, baseVersion: 0, envelopeVersion: ENVELOPE_VERSION, ciphertext: opaqueCiphertext() },
    storage,
  );
  assert.equal(stale.status, 'conflict', 'a stale push was accepted');
  if (stale.status !== 'conflict') throw new Error('unreachable');
  assert.equal(stale.currentVersion, 1, 'the conflict did not report the version the caller must re-read');

  const pulled = await handlePullBlob(ACCOUNT_ID, storage);
  assert.equal(pulled.status, 'found');
  if (pulled.status !== 'found') throw new Error('unreachable');
  assert.deepEqual(pulled.blob.ciphertext, winner, 'the refused push overwrote the stored blob');
});

test('pulling an account that never pushed is not-found', async () => {
  const storage = createFakeStorageAdapter();

  const result = await handlePullBlob(ACCOUNT_ID, storage);

  assert.equal(result.status, 'not-found');
});
