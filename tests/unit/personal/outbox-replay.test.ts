/**
 * Strict ascending replay of the write outbox, driven through the real
 * `flushOutbox` against a real in-memory TinyBase store.
 *
 * WHAT THIS PROTECTS
 *   An outbox record is a queued INTENT to run a sync cycle. The order they
 *   replay in is the order the device's writes reach the account, and the rule
 *   is strict: a later record never goes up while an earlier one is still
 *   unsent. Break it and a device silently reorders someone's edits.
 *
 * THE DEFECTS THESE CASES CATCH
 *   - A flush that continues past a failure, carrying record 3 up while
 *     record 2 is still queued.
 *   - A failure that DROPS the record instead of parking it. A dropped record
 *     is a write nobody ever hears about again, and neither the UI nor the
 *     queue can tell it happened.
 *   - The prefix stop ACROSS RUNS, which is the one `selectFlushableRecords`
 *     was written for: `flushOutbox`'s own stop-on-first-failure only protects
 *     a single run, so without the prefix stop a fresh run would happily
 *     select a later ready record and flush it ahead of the earlier one that
 *     an earlier run already backed off.
 *   - A `401` burning a retry instead of asking for a re-login, and a `400`
 *     being retried forever instead of parked.
 *
 * Every constant is imported. Asserting backoff against a literal number of
 * milliseconds would mean a change to the policy leaves a green test asserting
 * the old one.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  BASE_BACKOFF_MS,
  MAX_BACKOFF_MS,
  classifyFlushOutcome,
  computeBackoffMs,
  createOutboxStore,
  enqueueSyncIntent,
  flushOutbox,
  listOutboxRecords,
  type OutboxRecord,
  type OutboxRunner,
  type SyncAttemptResult,
} from '#app/lib/local-store';
import type { Store } from 'tinybase';

/** A fixed clock base, so every `nextAttemptAt` below is an exact expected value. */
const T0 = 1_760_000_000_000;

/** A runner paired with the sequences it was handed, in call order. */
interface RecordingRunner {
  run: OutboxRunner;
  sequences: number[];
}

/** A runner that records the sequence of every record it was handed, and answers per that sequence. */
function recordingRunner(answer: (record: OutboxRecord) => Promise<SyncAttemptResult>): RecordingRunner {
  const sequences: number[] = [];
  return {
    sequences,
    run: async (record) => {
      sequences.push(record.sequence);
      return answer(record);
    },
  };
}

async function ok(): Promise<SyncAttemptResult> {
  return { ok: true, status: 200 };
}

/** Queues `count` intents on a fresh store, in order, and returns both. */
async function storeWithIntents(count: number): Promise<{ store: Store; records: OutboxRecord[] }> {
  const store = createOutboxStore();
  const records: OutboxRecord[] = [];
  for (let index = 1; index <= count; index += 1) {
    records.push(await enqueueSyncIntent({ clientId: `client-${index}` }, { store, now: () => T0 + index }));
  }
  return { store, records };
}

describe('outbox replay order', () => {
  it('carries every record up in strictly ascending sequence', async () => {
    const { store, records } = await storeWithIntents(4);
    assert.deepEqual(
      records.map((record) => record.sequence),
      [1, 2, 3, 4],
      'the enqueue did not assign ascending sequences',
    );

    const runner = recordingRunner(ok);
    const result = await flushOutbox({ store, run: runner.run, now: () => T0 + 100 });

    // The count matters as much as the order: a runner called zero times
    // satisfies "ascending" trivially.
    assert.equal(runner.sequences.length, 4, 'the flush did not attempt every queued record');
    assert.deepEqual(runner.sequences, [1, 2, 3, 4], 'the flush replayed out of order');
    assert.equal(result.flushed, 4);
    assert.equal(result.stopped, false);
    assert.deepEqual(await listOutboxRecords({ store }), [], 'a confirmed record was left in the queue');
  });

  it('stops at the first failure, keeps the failed record and never reaches the next one', async () => {
    const { store } = await storeWithIntents(3);

    const runner = recordingRunner(async (record) =>
      record.sequence === 2 ? { ok: false, status: 500 } : { ok: true, status: 200 },
    );
    const result = await flushOutbox({ store, run: runner.run, now: () => T0 + 100 });

    assert.deepEqual(runner.sequences, [1, 2], 'the flush attempted a record after a failure');
    assert.equal(result.flushed, 1);
    assert.equal(result.stopped, true);

    const remaining = (await listOutboxRecords({ store })).toSorted((a, b) => a.sequence - b.sequence);
    assert.deepEqual(
      remaining.map((record) => record.sequence),
      [2, 3],
      'the queue does not hold exactly the unsent records',
    );

    const [failed] = remaining;
    if (failed === undefined) throw new Error('unreachable');
    assert.equal(failed.status, 'failed', 'the failed record was not parked');
    assert.equal(failed.attempts, 1);
    assert.equal(failed.nextAttemptAt, T0 + 100 + computeBackoffMs(1), 'the failed record was not backed off');
  });

  it('does not select a later ready record while an earlier one is still backed off', async () => {
    // THE PREFIX STOP, ACROSS TWO SEPARATE RUNS. The first run parks record 1.
    // The second run is fresh: nothing in it knows about the first, and
    // record 2 is ready. Only `selectFlushableRecords`'s prefix stop keeps it
    // from going up first.
    const { store } = await storeWithIntents(2);

    const firstRun = recordingRunner(async () => ({ ok: false, status: 500 }));
    await flushOutbox({ store, run: firstRun.run, now: () => T0 });
    assert.deepEqual(firstRun.sequences, [1], 'the first run did not park exactly the first record');

    // Well inside record 1's backoff window, and record 2 has never been tried
    // so it is ready.
    const secondRun = recordingRunner(ok);
    const result = await flushOutbox({ store, run: secondRun.run, now: () => T0 + 1 });

    assert.deepEqual(secondRun.sequences, [], 'a fresh run flushed a later record ahead of a backed-off earlier one');
    assert.equal(result.flushed, 0);
    assert.equal(result.nextRetryAt, T0 + computeBackoffMs(1), 'the run did not report when the parked record is due');

    // And the prefix stop releases once the window elapses, so this is a delay
    // and not a permanent stall.
    const thirdRun = recordingRunner(ok);
    await flushOutbox({ store, run: thirdRun.run, now: () => T0 + computeBackoffMs(1) });
    assert.deepEqual(thirdRun.sequences, [1, 2], 'the queue did not drain once the backoff elapsed');
  });
});

describe('flush outcome classification', () => {
  it('classifies every documented case', () => {
    assert.equal(classifyFlushOutcome({ ok: true, status: 200 }), 'success');
    assert.equal(classifyFlushOutcome({ ok: false, status: 401 }), 'authStop');
    assert.equal(classifyFlushOutcome({ ok: false, status: 403 }), 'authStop');
    assert.equal(classifyFlushOutcome({ ok: false, status: 400 }), 'fatal');
    assert.equal(classifyFlushOutcome({ ok: false, status: 413 }), 'fatal');
    assert.equal(classifyFlushOutcome({ ok: false, status: 500 }), 'retry');
    // A thrown fetch — the connection dropped before any status existed.
    assert.equal(classifyFlushOutcome({ ok: false, status: null }), 'retry');
  });

  it('keeps a 401 record pending and asks for a re-login rather than burning a retry', async () => {
    const { store } = await storeWithIntents(1);

    const result = await flushOutbox({
      store,
      run: async () => ({ ok: false, status: 401 }),
      now: () => T0 + 100,
    });

    assert.equal(result.surface, 'reauth', 'a 401 did not surface a re-login');
    assert.equal(result.stopped, true);
    assert.equal(result.nextRetryAt, null, 'an auth stop scheduled a retry that cannot succeed');

    const [record] = await listOutboxRecords({ store });
    if (record === undefined) throw new Error('the 401 dropped the record');
    assert.equal(record.status, 'pending', 'a 401 moved the record out of pending');
    assert.equal(record.attempts, 0, 'a 401 burned a retry attempt');
  });

  it('parks a 400 record as blocked and never drops it', async () => {
    const { store } = await storeWithIntents(1);

    const result = await flushOutbox({
      store,
      run: async () => ({ ok: false, status: 400 }),
      now: () => T0 + 100,
    });

    assert.equal(result.surface, 'blocked');
    assert.equal(result.flushed, 0, 'a permanent rejection removed the record');
    assert.equal(result.remaining, 1, 'a permanent rejection dropped the record');

    const [record] = await listOutboxRecords({ store });
    if (record === undefined) throw new Error('the 400 dropped the record');
    assert.equal(record.status, 'blocked');
  });
});

describe('retry backoff', () => {
  it('doubles per attempt and is capped', () => {
    assert.equal(computeBackoffMs(1), BASE_BACKOFF_MS);
    assert.equal(computeBackoffMs(2), BASE_BACKOFF_MS * 2);
    assert.equal(computeBackoffMs(3), BASE_BACKOFF_MS * 4);

    // The cap, reached from the first attempt count that exceeds it rather
    // than from an arbitrary large number, so the case still means something
    // if either constant moves.
    const attemptsToCap = Math.ceil(Math.log2(MAX_BACKOFF_MS / BASE_BACKOFF_MS)) + 1;
    assert.equal(computeBackoffMs(attemptsToCap), MAX_BACKOFF_MS, 'the backoff did not reach the cap');
    assert.equal(computeBackoffMs(attemptsToCap + 10), MAX_BACKOFF_MS, 'the backoff grew past the cap');
  });
});
