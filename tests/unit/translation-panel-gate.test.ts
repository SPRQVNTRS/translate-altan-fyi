/**
 * The translation gate: which of five answers a search gets, and in what order
 * the three guards are asked.
 *
 * WHAT THIS FILE HOLDS IN PLACE
 *   Every path through `resolveTriggeredTranslationPanel` decides whether a
 *   model is called, and two of them are the ones that cost money. A ready pair
 *   must never reach the rate limiter, or the honest majority of readers, the
 *   ones landing on words the dictionary already answers, would be the ones
 *   exhausting the limit while a script walking untranslated words kept its full
 *   allowance. A failed pair must not re-enqueue on every reload, or one
 *   provider outage becomes a job per page view. And the rate limit is asked
 *   LAST of the three guards, immediately before the enqueue it guards, because
 *   asking it is itself the spend: `checkTriggerRateLimit` bumps the caller's
 *   counters on every call, allowed or not. A search the budget or the daily
 *   cap was always going to refuse must not also cost the reader one of the
 *   twenty tokens an hour they are given for browsing, which is what asking it
 *   first used to do.
 *
 * THE READS ARE FAKED, ALL FIVE OF THEM. `panel.server.ts` reads the corpus, the
 * run ledger, the rate limiter, the budget and the queue, each through its own
 * module, and each one is replaced here. Nothing in this file opens a database:
 * `#drizzle/db` connects at module load and is stubbed to throw, so a read this
 * test forgot to fake fails loudly instead of hanging on a pool.
 *
 * THE CALL LOG IS THE ASSERTION FOR ORDER. Asserting only the returned reason
 * would pass on an implementation that asked all three guards and picked a
 * winner afterwards, which is a different program: it would spend a rate-limit
 * token on a request the daily cap had already turned away.
 */
import { describe, it, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';

import type { TranslationRow } from '#app/lib/translation/translations-query.server';
import type { TranslationRunView } from '#app/models/translation-runs.server';

mock.module('#drizzle/db', {
  namedExports: {
    getRawDb: () => {
      throw new Error('the unit tier must not reach a database');
    },
  },
});

/** What the fakes below are told to answer, rewritten by each case. */
interface FakeReads {
  translations: TranslationRow[];
  run: TranslationRunView | null;
  rateLimitAllowed: boolean;
  budgetExhausted: boolean;
  runsToday: number;
  enqueueOutcome: 'queued' | 'deduped' | 'unavailable';
}

const fake: FakeReads = {
  translations: [],
  run: null,
  rateLimitAllowed: true,
  budgetExhausted: false,
  runsToday: 0,
  enqueueOutcome: 'queued',
};

/** Which reads happened, in order. The gate ORDER is what this proves. */
let calls: string[] = [];

mock.module('#app/lib/translation/translations-query.server', {
  namedExports: {
    listTranslationsInto: () => {
      calls.push('translations');
      return Promise.resolve(fake.translations);
    },
  },
});

mock.module('#app/models/translation-runs.server', {
  namedExports: {
    latestRun: () => {
      calls.push('latestRun');
      return Promise.resolve(fake.run);
    },
    countRunsToday: () => {
      calls.push('countRunsToday');
      return Promise.resolve(fake.runsToday);
    },
  },
});

mock.module('#app/lib/abuse/rate-limit.server', {
  namedExports: {
    checkTriggerRateLimit: () => {
      calls.push('rateLimit');
      return Promise.resolve({ allowed: fake.rateLimitAllowed });
    },
  },
});

mock.module('#app/lib/abuse/budget.server', {
  namedExports: {
    isBudgetExhausted: () => {
      calls.push('budget');
      return Promise.resolve(fake.budgetExhausted);
    },
  },
});

mock.module('#app/lib/translation/enqueue.server', {
  namedExports: {
    enqueueTranslation: () => {
      calls.push('enqueue');
      return Promise.resolve(
        fake.enqueueOutcome === 'queued' ?
          { outcome: 'queued', runId: 'run-1' }
        : { outcome: fake.enqueueOutcome, runId: null },
      );
    },
  },
});

const { resolveTranslationPanel, resolveTriggeredTranslationPanel } = await import(
  '#app/lib/translation/panel.server'
);
const { MAX_TRANSLATION_RUNS_PER_DAY } = await import('#app/lib/translation/limits');

// SAFETY: every read this module performs is faked above, so the handle is
// passed from function to function and never dereferenced. `never` is the
// narrowest way to say "this value is not used", and any fake that did touch it
// would fail on the first property access rather than silently querying.
/** The database handle every function here takes and none of the fakes reads. */
const db = {} as never;

/** The key under test, one German word into Turkish, which is the case M193 was written for. */
const key = { headwordId: '99a991dc-8e80-4b65-82e5-effbbaf84269', from: 'de', to: 'tr' } as const;

const request = new Request('https://kenning.altan.fyi/?q=umwerfen');

/** One translation row, as the corpus read returns it. */
function row(overrides: Partial<TranslationRow> = {}): TranslationRow {
  return {
    translationId: 'b0f1c8a4-2f52-4a1a-9f3d-1c2b3a4d5e6f',
    lemma: 'devirmek',
    pos: 'verb',
    confidence: 0.9,
    note: null,
    generated: true,
    up: 0,
    down: 0,
    myVote: null,
    ...overrides,
  };
}

/** One run row, with only the fields the resolver reads filled in. */
function run(status: TranslationRunView['status'], error: string | null = null): TranslationRunView {
  return {
    id: 'run-0',
    headwordId: key.headwordId,
    from: key.from,
    to: key.to,
    promptVersion: 1,
    provider: 'openrouter',
    model: 'a-model',
    status,
    output: null,
    written: null,
    capped: false,
    error,
    costUsd: null,
    latencyMs: null,
    createdAt: new Date('2026-09-05T10:00:00.000Z'),
    finishedAt: null,
    retractedAt: null,
  };
}

beforeEach(() => {
  calls = [];
  fake.translations = [];
  fake.run = null;
  fake.rateLimitAllowed = true;
  fake.budgetExhausted = false;
  fake.runsToday = 0;
  fake.enqueueOutcome = 'queued';
});

describe('the translation resolver, which never enqueues', () => {
  it('reports ready when the corpus already holds the pair, without reading the run ledger', async () => {
    fake.translations = [row()];
    const panel = await resolveTranslationPanel(db, key);
    assert.deepEqual(panel, { state: 'ready', translations: [row()] });
    // The ledger is not even read: rows on the page are the answer, whatever any
    // earlier attempt to add more of them did.
    assert.deepEqual(calls, ['translations']);
  });

  it('reports translating for an open run, and failed for the latest failed one', async () => {
    fake.run = run('pending');
    assert.deepEqual(await resolveTranslationPanel(db, key), { state: 'translating' });

    fake.run = run('failed', 'the model answered nothing usable');
    assert.deepEqual(await resolveTranslationPanel(db, key), {
      state: 'failed',
      canRetry: true,
      error: 'the model answered nothing usable',
    });
  });

  it('reports none for a pair nobody has asked about, and for a run that finished with nothing', async () => {
    assert.deepEqual(await resolveTranslationPanel(db, key), { state: 'none' });
    fake.run = run('ok');
    assert.deepEqual(await resolveTranslationPanel(db, key), { state: 'none' });
  });

  it('never enqueues, whatever it is asked', async () => {
    await resolveTranslationPanel(db, key);
    fake.run = run('failed');
    await resolveTranslationPanel(db, key);
    assert.equal(calls.includes('enqueue'), false);
    assert.equal(calls.includes('rateLimit'), false);
  });
});

describe('the translation trigger, which may', () => {
  it('short-circuits a ready pair before any guard runs, and never spends a rate-limit token', async () => {
    fake.translations = [row({ generated: false })];
    const panel = await resolveTriggeredTranslationPanel(db, { ...key, request });
    assert.equal(panel.state, 'ready');
    assert.deepEqual(calls, ['translations']);
    assert.equal(calls.includes('rateLimit'), false);
  });

  it('short-circuits an open run, so a second identical search queues nothing, and spends no rate-limit token', async () => {
    fake.run = run('pending');
    const panel = await resolveTriggeredTranslationPanel(db, { ...key, request });
    assert.equal(panel.state, 'translating');
    assert.equal(calls.includes('enqueue'), false);
    assert.equal(calls.includes('rateLimit'), false);
  });

  it('leaves a failure alone unless the reader asked again, and spends no rate-limit token', async () => {
    fake.run = run('failed');
    const panel = await resolveTriggeredTranslationPanel(db, { ...key, request });
    assert.deepEqual(panel, { state: 'failed', canRetry: true, error: null });
    assert.equal(calls.includes('enqueue'), false);
    assert.equal(calls.includes('rateLimit'), false);
  });

  it('re-enqueues a failure when the reader pressed retry, asking the rate limit last of the three guards', async () => {
    fake.run = run('failed');
    const panel = await resolveTriggeredTranslationPanel(db, { ...key, request, retry: true });
    assert.deepEqual(panel, { state: 'translating' });
    assert.deepEqual(calls, ['translations', 'latestRun', 'budget', 'countRunsToday', 'rateLimit', 'enqueue']);
  });

  it('enqueues for a headword nobody has asked about, which is the zero-sense case', async () => {
    const panel = await resolveTriggeredTranslationPanel(db, { ...key, request });
    assert.deepEqual(panel, { state: 'translating' });
    assert.equal(calls.at(-1), 'enqueue');
  });

  it('treats a deduped enqueue as translating, and an unavailable queue as failed', async () => {
    fake.enqueueOutcome = 'deduped';
    assert.deepEqual(await resolveTriggeredTranslationPanel(db, { ...key, request }), { state: 'translating' });

    fake.enqueueOutcome = 'unavailable';
    const panel = await resolveTriggeredTranslationPanel(db, { ...key, request });
    assert.equal(panel.state, 'failed');
  });

  it(
    'asks the three guards budget, then daily cap, then rate limit, in that order, so a pair the ' +
      'first two would refuse never spends a rate-limit token at all',
    async () => {
      // The rate limit is refused too, and it is still asked last: the ORDER is
      // what this case proves, not merely the final answer. A rate-limited
      // request is a real request, so its rate-limit token IS spent here.
      fake.rateLimitAllowed = false;
      const panel = await resolveTriggeredTranslationPanel(db, { ...key, request });
      assert.deepEqual(panel, { state: 'budget', reason: 'rate-limited' });
      assert.deepEqual(calls, ['translations', 'latestRun', 'budget', 'countRunsToday', 'rateLimit']);
    },
  );

  it('refuses on the daily money budget first, and never asks the rate limit', async () => {
    fake.budgetExhausted = true;
    const panel = await resolveTriggeredTranslationPanel(db, { ...key, request });
    assert.deepEqual(panel, { state: 'budget', reason: 'budget' });
    assert.deepEqual(calls, ['translations', 'latestRun', 'budget']);
    assert.equal(calls.includes('rateLimit'), false);
  });

  it(
    'refuses on the system-wide daily run cap second, at the cap and not one run before it, and never ' +
      'asks the rate limit',
    async () => {
      fake.runsToday = MAX_TRANSLATION_RUNS_PER_DAY - 1;
      assert.deepEqual(await resolveTriggeredTranslationPanel(db, { ...key, request }), { state: 'translating' });

      calls = [];
      fake.runsToday = MAX_TRANSLATION_RUNS_PER_DAY;
      const panel = await resolveTriggeredTranslationPanel(db, { ...key, request });
      assert.deepEqual(panel, { state: 'budget', reason: 'daily-cap' });
      assert.deepEqual(calls, ['translations', 'latestRun', 'budget', 'countRunsToday']);
      assert.equal(calls.includes('enqueue'), false);
      assert.equal(calls.includes('rateLimit'), false);
    },
  );

  it('holds the cap at the figure the milestone fixed', () => {
    assert.equal(MAX_TRANSLATION_RUNS_PER_DAY, 200);
  });
});
