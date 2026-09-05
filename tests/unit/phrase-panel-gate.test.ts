/**
 * The phrase gate: which answer a typed sentence gets, and in what order the
 * four guards are asked.
 *
 * WHAT THIS FILE HOLDS IN PLACE
 *   Every path through `resolveTriggeredPhrasePanel` decides whether a model is
 *   called, and two of them are the ones that cost money. A sentence the cache
 *   already answers must never reach the rate limiter, or the honest majority of
 *   readers, the ones typing something this installation has already paid for,
 *   would be the ones exhausting the limit while a script pasting fresh
 *   paragraphs kept its full allowance. A failed sentence must not re-enqueue on
 *   every reload, or one provider outage becomes a job per page view. And the
 *   LENGTH CAP is asked first of the four, because it is free and certain: a
 *   text over the cap can never be translated however much budget is left, so
 *   every other question about it would be work spent on a refusal that was
 *   already decided.
 *
 *   THE REFUSAL WRITES NOTHING. That is asserted too: no row is opened on a
 *   refused path, so nothing newer than the existing state exists and a reader
 *   coming back under a fresh allowance reaches the same enqueue this one did
 *   not.
 *
 * THE READS ARE FAKED, ALL FIVE OF THEM. `phrase-panel.server.ts` reads the
 * cache, the ledger, the rate limiter, the budget and the queue, each through
 * its own module, and each one is replaced here. Nothing in this file opens a
 * database: `#drizzle/db` connects at module load and is stubbed to throw, so a
 * read this test forgot to fake fails loudly instead of hanging on a pool.
 *
 * THE CALL LOG IS THE ASSERTION FOR ORDER. Asserting only the returned reason
 * would pass on an implementation that asked all four guards and picked a winner
 * afterwards, which is a different program: it would spend a rate-limit token on
 * a request the length cap had already turned away.
 */
import { describe, it, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';

import type { PhraseTranslationView } from '#app/models/phrase-runs.server';

mock.module('#drizzle/db', {
  namedExports: {
    getRawDb: () => {
      throw new Error('the unit tier must not reach a database');
    },
  },
});

/** What the fakes below are told to answer, rewritten by each case. */
interface FakeReads {
  answer: PhraseTranslationView | null;
  latest: PhraseTranslationView | null;
  rateLimitAllowed: boolean;
  budgetExhausted: boolean;
  runsToday: number;
  enqueueOutcome: 'queued' | 'deduped' | 'unavailable';
}

const fake: FakeReads = {
  answer: null,
  latest: null,
  rateLimitAllowed: true,
  budgetExhausted: false,
  runsToday: 0,
  enqueueOutcome: 'queued',
};

/** Which reads happened, in order. The gate ORDER is what this proves. */
let calls: string[] = [];

mock.module('#app/models/phrase-runs.server', {
  namedExports: {
    latestPhraseAnswer: () => {
      calls.push('cache');
      return Promise.resolve(fake.answer);
    },
    latestPhrase: () => {
      calls.push('latest');
      return Promise.resolve(fake.latest);
    },
    countPhraseRunsToday: () => {
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

mock.module('#app/lib/translation/phrase-enqueue.server', {
  namedExports: {
    enqueuePhrase: () => {
      calls.push('enqueue');
      return Promise.resolve(
        fake.enqueueOutcome === 'queued' ?
          { outcome: 'queued', runId: 'phrase-1' }
        : { outcome: fake.enqueueOutcome, runId: null },
      );
    },
  },
});

const { phraseKeyFromRequest, resolvePhrasePanel, resolveTriggeredPhrasePanel } = await import(
  '#app/lib/translation/phrase-panel.server'
);
const { MAX_PHRASE_RUNS_PER_DAY, PHRASE_MAX_CHARS } = await import('#app/lib/translation/limits');

// SAFETY: every read this module performs is faked above, so the handle is
// passed from function to function and never dereferenced. `never` is the
// narrowest way to say "this value is not used", and any fake that did touch it
// would fail on the first property access rather than silently querying.
/** The database handle every function here takes and none of the fakes reads. */
const db = {} as never;

/** The sentence under test: the one the operator reported on 2026-09-05. */
const key = {
  sourceText: 'Das auto volltanken',
  sourceNormalized: 'das auto volltanken',
  from: 'de',
  to: 'tr',
} as const;

const request = new Request('https://translate.altan.fyi/?q=Das%20auto%20volltanken');

/** One phrase row, with only the fields the resolver reads filled in. */
function row(status: PhraseTranslationView['status'], overrides: Partial<PhraseTranslationView> = {}) {
  return {
    id: 'phrase-0',
    from: key.from,
    to: key.to,
    sourceText: key.sourceText,
    sourceNormalized: key.sourceNormalized,
    status,
    translationText: null,
    provider: 'openrouter',
    model: 'a-model',
    promptVersion: 1,
    costUsd: null,
    latencyMs: null,
    error: null,
    createdAt: new Date('2026-09-05T10:00:00.000Z'),
    finishedAt: null,
    ...overrides,
  } satisfies PhraseTranslationView;
}

beforeEach(() => {
  calls = [];
  fake.answer = null;
  fake.latest = null;
  fake.rateLimitAllowed = true;
  fake.budgetExhausted = false;
  fake.runsToday = 0;
  fake.enqueueOutcome = 'queued';
});

describe('the phrase resolver, which never enqueues', () => {
  it('serves the cached answer as one ready row, without reading the ledger', async () => {
    fake.answer = row('ok', { translationText: 'Arabayı depoya kadar doldur' });
    const panel = await resolvePhrasePanel(db, key);
    assert.deepEqual(panel, {
      state: 'ready',
      translations: [
        {
          translationId: 'phrase-0',
          lemma: 'Arabayı depoya kadar doldur',
          pos: null,
          confidence: null,
          generated: true,
          up: 0,
          down: 0,
          myVote: null,
        },
      ],
    });
    // The ledger is not even read: an answer on the screen is the answer,
    // whatever a later attempt to produce another one did.
    assert.deepEqual(calls, ['cache']);
  });

  it('reports translating for an open run, and failed for the latest failed one', async () => {
    fake.latest = row('pending');
    assert.deepEqual(await resolvePhrasePanel(db, key), { state: 'translating' });

    fake.latest = row('failed', { error: 'the model answered nothing usable' });
    assert.deepEqual(await resolvePhrasePanel(db, key), {
      state: 'failed',
      canRetry: true,
      error: 'the model answered nothing usable',
    });
  });

  it('reports none for a sentence nobody has asked about, and for an ok row with no text', async () => {
    assert.deepEqual(await resolvePhrasePanel(db, key), { state: 'none' });
    fake.latest = row('ok');
    assert.deepEqual(await resolvePhrasePanel(db, key), { state: 'none' });
  });

  it('never enqueues and never spends a rate-limit token, whatever it is asked', async () => {
    await resolvePhrasePanel(db, key);
    fake.latest = row('failed');
    await resolvePhrasePanel(db, key);
    assert.equal(calls.includes('enqueue'), false);
    assert.equal(calls.includes('rateLimit'), false);
  });
});

describe('the phrase trigger, which may', () => {
  it('short-circuits a cached sentence before any guard runs, and never spends a rate-limit token', async () => {
    fake.answer = row('ok', { translationText: 'Arabayı depoya kadar doldur' });
    const panel = await resolveTriggeredPhrasePanel(db, { ...key, request });
    assert.equal(panel.state, 'ready');
    assert.deepEqual(calls, ['cache']);
  });

  it('short-circuits an open run, so a second identical search queues nothing', async () => {
    fake.latest = row('pending');
    const panel = await resolveTriggeredPhrasePanel(db, { ...key, request });
    assert.equal(panel.state, 'translating');
    assert.equal(calls.includes('enqueue'), false);
    assert.equal(calls.includes('rateLimit'), false);
  });

  it('leaves a failure alone unless the reader asked again', async () => {
    fake.latest = row('failed');
    const panel = await resolveTriggeredPhrasePanel(db, { ...key, request });
    assert.deepEqual(panel, { state: 'failed', canRetry: true, error: null });
    assert.equal(calls.includes('enqueue'), false);
  });

  it('enqueues for a sentence nobody has asked about, asking the four guards in order', async () => {
    const panel = await resolveTriggeredPhrasePanel(db, { ...key, request });
    assert.deepEqual(panel, { state: 'translating' });
    assert.deepEqual(calls, ['cache', 'latest', 'rateLimit', 'countRunsToday', 'budget', 'enqueue']);
  });

  it('refuses a text over the length cap first of all, before any other question is asked', async () => {
    const tooLong = 'a'.repeat(PHRASE_MAX_CHARS + 1);
    const panel = await resolveTriggeredPhrasePanel(db, {
      ...key,
      sourceText: tooLong,
      sourceNormalized: tooLong,
      request,
    });
    assert.deepEqual(panel, { state: 'budget', reason: 'too-long' });
    // The two reads that decide the state still happen, because the cap is a
    // guard on STARTING work and a text this long may already have an answer.
    // Past them, nothing: no counter is read and no token is spent.
    assert.deepEqual(calls, ['cache', 'latest']);
  });

  it('accepts a text exactly at the cap, so the boundary is not off by one', async () => {
    const atCap = 'a'.repeat(PHRASE_MAX_CHARS);
    const panel = await resolveTriggeredPhrasePanel(db, { ...key, sourceText: atCap, sourceNormalized: atCap, request });
    assert.deepEqual(panel, { state: 'translating' });
    assert.equal(calls.at(-1), 'enqueue');
  });

  it('refuses a rate-limited caller before it reads either installation-wide counter', async () => {
    fake.rateLimitAllowed = false;
    const panel = await resolveTriggeredPhrasePanel(db, { ...key, request });
    assert.deepEqual(panel, { state: 'budget', reason: 'rate-limited' });
    assert.deepEqual(calls, ['cache', 'latest', 'rateLimit']);
  });

  it('refuses at the day cap before it asks the budget', async () => {
    fake.runsToday = MAX_PHRASE_RUNS_PER_DAY;
    const panel = await resolveTriggeredPhrasePanel(db, { ...key, request });
    assert.deepEqual(panel, { state: 'budget', reason: 'daily-cap' });
    assert.deepEqual(calls, ['cache', 'latest', 'rateLimit', 'countRunsToday']);
  });

  it('refuses on an exhausted budget, last of the four', async () => {
    fake.budgetExhausted = true;
    const panel = await resolveTriggeredPhrasePanel(db, { ...key, request });
    assert.deepEqual(panel, { state: 'budget', reason: 'budget' });
    assert.deepEqual(calls, ['cache', 'latest', 'rateLimit', 'countRunsToday', 'budget']);
  });

  it('re-enqueues a failure when the reader pressed retry', async () => {
    fake.latest = row('failed');
    const panel = await resolveTriggeredPhrasePanel(db, { ...key, request, retry: true });
    assert.deepEqual(panel, { state: 'translating' });
    assert.equal(calls.at(-1), 'enqueue');
  });

  it('treats a deduped enqueue as translating, and an unavailable queue as failed', async () => {
    fake.enqueueOutcome = 'deduped';
    assert.deepEqual(await resolveTriggeredPhrasePanel(db, { ...key, request }), { state: 'translating' });

    fake.enqueueOutcome = 'unavailable';
    const panel = await resolveTriggeredPhrasePanel(db, { ...key, request });
    assert.deepEqual(panel, {
      state: 'failed',
      canRetry: true,
      error: 'the translation queue is not available',
    });
  });
});

describe('the polling key, read out of a query string', () => {
  it('folds the text the same way the cache key was written, so a poll finds its own row', () => {
    const url = new URL('https://translate.altan.fyi/api/translation-phrase?q=%20Das%20Auto%20%20volltanken%20&from=de&to=tr');
    assert.deepEqual(phraseKeyFromRequest(url), {
      sourceText: 'Das Auto  volltanken',
      sourceNormalized: 'das auto volltanken',
      from: 'de',
      to: 'tr',
    });
  });

  it('answers null for an empty query and for a language this installation does not serve', () => {
    assert.equal(phraseKeyFromRequest(new URL('https://x.test/?q=&from=de&to=tr')), null);
    assert.equal(phraseKeyFromRequest(new URL('https://x.test/?q=hallo&from=de&to=fr')), null);
    assert.equal(phraseKeyFromRequest(new URL('https://x.test/?q=hallo&to=tr')), null);
  });
});
