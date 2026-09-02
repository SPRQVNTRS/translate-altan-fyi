/**
 * Unit tests for `connectWithRetry` — the exponential-backoff helper used by
 * `drizzle/db.ts:initializePool()`. No real database is involved; the pool is a
 * plain object satisfying the `ClientSource` contract.
 */
import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';

import { connectWithRetry, type ClientSource, type RetryLogger } from '../../drizzle/pool-retry';

/** Stand-in for `pg.PoolClient` — `connectWithRetry` only ever hands it back. */
type TestClient = { release: () => void };

type ConnectFn = () => Promise<TestClient>;

function makePool(connect: ConnectFn): ClientSource<TestClient> {
  return { connect };
}

function makeLogger() {
  const warn = mock.fn<RetryLogger['warn']>(() => {});
  return { logger: { warn } satisfies RetryLogger, warn };
}

const fakeClient: TestClient = { release: () => {} };

describe('connectWithRetry', () => {
  it('resolves when pool.connect succeeds after N-1 rejections', async () => {
    const N = 4;
    let calls = 0;
    const connect = mock.fn<ConnectFn>(async () => {
      calls += 1;
      if (calls < N) throw new Error(`transient ${calls}`);
      return fakeClient;
    });

    const { logger, warn } = makeLogger();
    const sleep = mock.fn(async (_ms: number) => {});

    const client = await connectWithRetry(makePool(connect), N, {
      logger,
      sleep,
      random: () => 0.5,
    });

    assert.strictEqual(client, fakeClient);
    assert.strictEqual(calls, N, 'pool.connect should be called exactly N times');
    assert.strictEqual(warn.mock.callCount(), N - 1, 'logger.warn fires once per intermediate retry');
    assert.strictEqual(sleep.mock.callCount(), N - 1, 'sleep fires once per intermediate retry');
  });

  it('rejects with the original error when every attempt fails', async () => {
    const originalErr = new Error('boom-final');
    let calls = 0;
    const connect = mock.fn<ConnectFn>(async () => {
      calls += 1;
      // First call throws a different error to ensure we rethrow the LAST one.
      if (calls === 1) throw new Error('boom-first');
      throw originalErr;
    });

    const { logger } = makeLogger();
    const sleep = mock.fn(async (_ms: number) => {});

    await assert.rejects(
      () =>
        connectWithRetry(makePool(connect), 2, {
          logger,
          sleep,
          random: () => 0.5,
        }),
      (cause: unknown) => cause === originalErr,
    );

    assert.strictEqual(calls, 2);
  });

  it('logs warn exactly N-1 times when all attempts fail', async () => {
    const N = 3;
    const connect = mock.fn<ConnectFn>(async () => {
      throw new Error('always-fails');
    });

    const { logger, warn } = makeLogger();
    const sleep = mock.fn(async (_ms: number) => {});

    await assert.rejects(() =>
      connectWithRetry(makePool(connect), N, {
        logger,
        sleep,
        random: () => 0.5,
      }),
    );

    assert.strictEqual(warn.mock.callCount(), N - 1);
    // Each warn call must carry the structured context the spec requires.
    for (const call of warn.mock.calls) {
      const [msg, ctx] = call.arguments;
      assert.strictEqual(msg, 'Database pool connection attempt failed, retrying');
      assert.ok(Number.isFinite(ctx.attempt));
      assert.strictEqual(ctx.maxAttempts, N);
      assert.ok(Number.isFinite(ctx.delayMs));
      assert.strictEqual(ctx.error, 'always-fails');
    }
  });

  it('sleeps for a value in [base*0.8, base*1.2] on each retry', async () => {
    const N = 4;
    const connect = mock.fn<ConnectFn>(async () => {
      throw new Error('never');
    });

    const { logger } = makeLogger();
    const sleep = mock.fn(async (_ms: number) => {});

    // Exercise the min and max ends of the jitter range across attempts.
    const randomValues = [0, 1, 0.5, 0]; // unused on final attempt
    let i = 0;
    const random = () => randomValues[i++] ?? 0.5;

    await assert.rejects(() =>
      connectWithRetry(makePool(connect), N, { logger, sleep, random }),
    );

    assert.strictEqual(sleep.mock.callCount(), N - 1);

    const bases = [1000, 2000, 4000]; // 1000 * 2^attempt for attempts 0..2
    for (let attempt = 0; attempt < N - 1; attempt += 1) {
      const delay = sleep.mock.calls[attempt]!.arguments[0];
      const base = bases[attempt]!;
      const lo = Math.floor(base * 0.8);
      const hi = Math.ceil(base * 1.2);
      assert.ok(
        delay >= lo && delay <= hi,
        `attempt ${attempt}: delay ${delay} not in [${lo}, ${hi}]`,
      );
    }
  });

  it('caps the per-attempt base delay at 30s', async () => {
    // attempt 5 → 1000 * 2^5 = 32_000 → capped at 30_000
    // attempt 6 → 1000 * 2^6 = 64_000 → capped at 30_000
    const N = 8;
    const connect = mock.fn<ConnectFn>(async () => {
      throw new Error('cap-test');
    });

    const { logger } = makeLogger();
    const sleep = mock.fn(async (_ms: number) => {});

    await assert.rejects(() =>
      connectWithRetry(makePool(connect), N, {
        logger,
        sleep,
        random: () => 1, // max jitter -> base * 1.2
      }),
    );

    // attempts 5 and 6 should both be capped: 30_000 * 1.2 = 36_000
    const cappedAttempts = [5, 6];
    for (const attempt of cappedAttempts) {
      const delay = sleep.mock.calls[attempt]!.arguments[0];
      assert.strictEqual(delay, Math.round(30_000 * 1.2));
    }
  });

  it('fails fast on non-retriable pg error (28P01 invalid_password)', async () => {
    const authErr = Object.assign(new Error('password authentication failed for user "wrong"'), {
      code: '28P01',
    });
    const connect = mock.fn<ConnectFn>(async () => {
      throw authErr;
    });

    const { logger, warn } = makeLogger();
    const sleep = mock.fn(async (_ms: number) => {});

    await assert.rejects(
      () => connectWithRetry(makePool(connect), 6, { logger, sleep, random: () => 0.5 }),
      (cause: unknown) => cause === authErr,
    );

    assert.strictEqual(
      connect.mock.callCount(),
      1,
      'should not retry past the first attempt',
    );
    assert.strictEqual(sleep.mock.callCount(), 0, 'no sleeps when bailing out non-retriable');
    assert.strictEqual(warn.mock.callCount(), 1);
    const [msg, ctx] = warn.mock.calls[0]!.arguments;
    assert.strictEqual(msg, 'Database pool connection failed with non-retriable error, aborting retry');
    assert.strictEqual(ctx.attempt, 0);
  });

  it('fails fast when every AggregateError sub-error is non-retriable', async () => {
    const aggregate = new AggregateError(
      [
        Object.assign(new Error('auth fail v4'), { code: '28P01' }),
        Object.assign(new Error('auth fail v6'), { code: '28P01' }),
      ],
      '',
    );
    const connect = mock.fn<ConnectFn>(async () => {
      throw aggregate;
    });

    const { logger, warn } = makeLogger();
    const sleep = mock.fn(async (_ms: number) => {});

    await assert.rejects(
      () => connectWithRetry(makePool(connect), 6, { logger, sleep, random: () => 0.5 }),
      (cause: unknown) => cause === aggregate,
    );

    assert.strictEqual(connect.mock.callCount(), 1);
    assert.strictEqual(sleep.mock.callCount(), 0);
    assert.strictEqual(warn.mock.callCount(), 1);
    assert.strictEqual(
      warn.mock.calls[0]!.arguments[0],
      'Database pool connection failed with non-retriable error, aborting retry',
    );
  });

  it('keeps retrying when AggregateError mixes retriable and non-retriable sub-errors', async () => {
    const mixed = new AggregateError(
      [
        Object.assign(new Error('auth fail v6'), { code: '28P01' }),
        Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5433'), { code: 'ECONNREFUSED' }),
      ],
      '',
    );
    let calls = 0;
    const connect = mock.fn<ConnectFn>(async () => {
      calls += 1;
      if (calls < 3) throw mixed;
      return fakeClient;
    });

    const { logger, warn } = makeLogger();
    const sleep = mock.fn(async (_ms: number) => {});

    const client = await connectWithRetry(makePool(connect), 4, {
      logger,
      sleep,
      random: () => 0.5,
    });

    assert.strictEqual(client, fakeClient);
    assert.strictEqual(calls, 3);
    assert.strictEqual(sleep.mock.callCount(), 2, 'should sleep before each retry');
    // All warns must be the retry message, NOT the non-retriable one.
    for (const call of warn.mock.calls) {
      assert.strictEqual(call.arguments[0], 'Database pool connection attempt failed, retrying');
    }
  });

  it('unwraps AggregateError sub-errors into the warn log error field', async () => {
    // pg.Pool emits AggregateError on ECONNREFUSED with empty top-level .message;
    // diagnostic detail lives in .errors[].
    const aggregate = new AggregateError(
      [new Error('connect ECONNREFUSED 127.0.0.1:5433'), new Error('connect ECONNREFUSED ::1:5433')],
      '',
    );
    let calls = 0;
    const connect = mock.fn<ConnectFn>(async () => {
      calls += 1;
      if (calls < 2) throw aggregate;
      return fakeClient;
    });

    const { logger, warn } = makeLogger();
    const sleep = mock.fn(async (_ms: number) => {});

    await connectWithRetry(makePool(connect), 2, {
      logger,
      sleep,
      random: () => 0.5,
    });

    assert.strictEqual(warn.mock.callCount(), 1);
    const ctx = warn.mock.calls[0]!.arguments[1];
    assert.strictEqual(
      ctx.error,
      'connect ECONNREFUSED 127.0.0.1:5433; connect ECONNREFUSED ::1:5433',
    );
  });

  it('fail-fast: maxAttempts=1 calls pool.connect once and never sleeps', async () => {
    const originalErr = new Error('immediate');
    const connect = mock.fn<ConnectFn>(async () => {
      throw originalErr;
    });

    const { logger, warn } = makeLogger();
    const sleep = mock.fn(async (_ms: number) => {});

    await assert.rejects(
      () => connectWithRetry(makePool(connect), 1, { logger, sleep }),
      (cause: unknown) => cause === originalErr,
    );

    assert.strictEqual(connect.mock.callCount(), 1);
    assert.strictEqual(sleep.mock.callCount(), 0);
    assert.strictEqual(warn.mock.callCount(), 0);
  });
});
