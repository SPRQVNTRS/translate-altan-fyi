/**
 * COUNSEL ADJUSTMENT H. The retry button is otherwise the one piece of M193
 * with no test anywhere in the tracker, and it is the one place this feature
 * re-sends a job under a singleton key that already has a row in `pgboss.job`.
 * This file proves the retry actually works rather than assuming it: a
 * `failed` run plus a click produces a NEW `pending` run row, for the SAME
 * `(headword, from, to)` key, and a NEW job on the queue, without pg-boss's
 * dedupe swallowing the second send.
 *
 * THE FIRST JOB IS MADE TO FAIL FOR REAL, THE SAME WAY THE RETRY ROUTE'S OWN
 * FILE COMMENT SAYS IT WAS PROVEN. That comment in
 * `app/routes/api.translation.$headwordId.retry.ts` records measuring pg-boss
 * directly: a second send while the first job is still `created` is deduped
 * away (`stately`'s unique index covers every state up to `active`), and a
 * second send once the first job has moved past `active` is accepted. This
 * file reproduces that exact measurement as an assertion: it starts a real run
 * through the search loader, flips BOTH the `translation_runs` row and the
 * `pgboss.job` row to a terminal state without ever running a worker, then
 * calls the retry action and checks that the second send was not swallowed.
 * A test that only checked the run row, and never touched `pgboss.job`, could
 * pass while the singleton key silently ate every retry.
 *
 * THE RETRY GOES THROUGH THE SAME GATE THE SEARCH DOES.
 * `resolveTriggeredTranslationPanel(..., { retry: true })` is what
 * `api.translation.$headwordId.retry.ts`'s action calls, so this file drives
 * that action directly rather than a bare `enqueueTranslation`, for the same
 * reason the other files in this set drive the search loader rather than the
 * resolver underneath it: the claim is about the route, not about the function
 * one layer down.
 *
 * THE ORCHESTRATOR IS INITIALISED, AND THE WORKER IS NEVER STARTED. See
 * `anonymous-search-enqueues-no-enrichment.test.ts` for the reason
 * `initializeWorkflows()` alone cannot run a real job: polling only begins
 * from `orchestrator.startWorker()`, which this file never calls.
 *
 * ISOLATION. One headword with a run-scoped suffix, removed through
 * `tearDownTranslationFixture` in foreign-key-safe order, which also removes
 * every `translation_runs` row this file created. The queued jobs and their
 * workflow row are deleted by this file. Every request carries a fresh
 * documentation-range address, and its rate-limit counter is deleted by key.
 *
 * THE PRECONDITION IS A REACHABLE DATABASE. `DB_HOST`, nothing else.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { asc, eq, inArray, sql } from 'drizzle-orm';
import { RouterContextProvider } from 'react-router';

import { abuseCounters, translationRuns, workflows } from '../../drizzle/schema';
import { closePool, getRawDb, poolInitialized } from '../../drizzle/db';
import { counterKey } from '../../app/lib/abuse/rate-limit.server';
import { finishRun } from '../../app/models/translation-runs.server';
import { translationSingletonKey } from '../../app/lib/translation/job-payload';
import { TRANSLATION_QUEUE } from '../../app/lib/translation/limits';
import { PROMPT_VERSION } from '../../app/prompts/translation/version';
import { action as retryTranslation } from '../../app/routes/api.translation.$headwordId.retry';
import { loader as translateLoader } from '../../app/routes/translate';
import { initializeWorkflows, stopOrchestrator } from '../../app/services/workflows.server';
import { createFakeLlmPort } from '../fixtures/fake-llm-port';
import { createTestUserSession, type TestUserSession } from '../fixtures/user-session';
import {
  seedHeadword,
  setUpTranslationFixture,
  tearDownTranslationFixture,
  type TranslationFixture,
} from '../fixtures/translation-corpus';

const DB_HOST = process.env.DB_HOST;

const db = getRawDb();

const FROM = 'de';
const TO = 'tr';

let fixture: TranslationFixture = {
  sourceId: '',
  generatedSourceId: '',
  fake: createFakeLlmPort(),
  run: '',
  seededHeadwordIds: [],
};
let session: TestUserSession | null = null;

let headwordId = '';
let lemma = '';
let singletonKey = '';
let firstRunId = '';

const createdCounterKeys: string[] = [];

/** One octet of a documentation-range address. */
function octet(): number {
  return 1 + Math.floor(Math.random() * 250);
}

function freshIp(): string {
  const ip = `198.51.${octet()}.${octet()}`;
  createdCounterKeys.push(counterKey('ip', ip));
  return ip;
}

async function search() {
  const ip = freshIp();
  const request = new Request(`https://kenning.altan.fyi/?q=${encodeURIComponent(lemma)}&from=${FROM}&to=${TO}`, {
    headers: { 'x-forwarded-for': ip, cookie: session?.cookie ?? '' },
  });
  return translateLoader({
    request,
    url: new URL(request.url),
    params: {},
    pattern: '/',
    context: new RouterContextProvider(),
  });
}

/** `POST /api/translation/:headwordId/retry?to=tr`, with the fixture's own session. */
async function retry() {
  const ip = freshIp();
  const request = new Request(`https://kenning.altan.fyi/api/translation/${headwordId}/retry?to=${TO}`, {
    method: 'POST',
    headers: { 'x-forwarded-for': ip, cookie: session?.cookie ?? '' },
  });
  const response = await retryTranslation({
    request,
    url: new URL(request.url),
    params: { headwordId },
    pattern: '/api/translation/:headwordId/retry',
    context: new RouterContextProvider(),
  });
  return response.json();
}

/** How many pg-boss jobs carry this pair's singleton key on the translation queue. */
async function countQueuedJobs(): Promise<number> {
  const result = await db.execute(
    sql`select count(*)::int as count from pgboss.job where name = ${TRANSLATION_QUEUE} and singleton_key = ${singletonKey}`,
  );
  const [row] = result.rows;
  return Number(row?.count ?? 0);
}

before(async () => {
  if (!DB_HOST) return;

  fixture = await setUpTranslationFixture('retry');
  session = await createTestUserSession('trans-retry');
  await initializeWorkflows();

  lemma = `zztransretry${fixture.run}`;
  headwordId = await seedHeadword(fixture, { lemma, languageCode: FROM, pos: 'noun' });
  singletonKey = translationSingletonKey({
    headwordId,
    from: FROM,
    to: TO,
    promptVersion: PROMPT_VERSION,
    runId: 'unused-the-key-drops-it',
  });

  // OPEN THE FIRST RUN FOR REAL, through the search loader, exactly like
  // `translation-zero-sense-search-enqueues-one.test.ts` does.
  assert.ok(session !== null, 'the fixture account was not created');
  const opened = await search();
  assert.equal(opened.translationPanel?.state, 'translating', 'the seeded first run never started');

  const [run] = await db
    .select({ id: translationRuns.id, status: translationRuns.status })
    .from(translationRuns)
    .where(eq(translationRuns.headwordId, headwordId));
  assert.ok(run, 'the run row the search loader opened is missing');
  firstRunId = run.id;

  // FAIL IT FOR REAL, ON BOTH SIDES. The run row is moved to `failed` the way
  // the job's own terminal path would, and the pg-boss row is moved to
  // `failed` directly, since no worker in this file will ever do it. Both
  // moves are what make the retry below a genuine second send under a key
  // pg-boss has already seen, not a first send in disguise.
  await finishRun(db, firstRunId, { status: 'failed', error: 'stub failure for the retry test' });
  await db.execute(sql`update pgboss.job set state = 'failed' where name = ${TRANSLATION_QUEUE} and singleton_key = ${singletonKey}`);
});

after(async () => {
  if (!DB_HOST) {
    await closePool();
    return;
  }

  await stopOrchestrator();
  await db.execute(sql`delete from pgboss.job where name = ${TRANSLATION_QUEUE} and singleton_key = ${singletonKey}`);
  await db.delete(workflows).where(sql`${workflows.context}->>'headwordId' = ${headwordId}`);
  if (createdCounterKeys.length > 0) {
    await db.delete(abuseCounters).where(inArray(abuseCounters.key, createdCounterKeys));
  }
  await tearDownTranslationFixture(fixture, []);
  if (session !== null) await session.dispose();

  await poolInitialized;
  await closePool();
});

describe('a retry on a failed translation run', () => {
  it(
    'opens a new pending run and a new job, without the pg-boss singleton key blocking it',
    { skip: !DB_HOST ? 'DB_HOST not set' : false },
    async () => {
      const jobsBefore = await countQueuedJobs();
      assert.equal(jobsBefore, 1, 'the seeded first job is missing, so this case would prove nothing');

      const panel = await retry();
      assert.equal(
        panel.state,
        'translating',
        `expected the retry to start a new run, got ${JSON.stringify(panel)}. If pg-boss deduped the second ` +
          "send away, the panel would still read 'failed' here.",
      );

      const runs = await db
        .select({ id: translationRuns.id, status: translationRuns.status })
        .from(translationRuns)
        .where(eq(translationRuns.headwordId, headwordId))
        .orderBy(asc(translationRuns.createdAt));
      assert.equal(runs.length, 2, `expected the failed run plus one retry, found ${runs.length} run row(s)`);
      assert.equal(runs[0]?.id, firstRunId, 'the original failed run must survive untouched: the table is append-only');
      assert.equal(runs[0]?.status, 'failed');
      assert.notEqual(runs[1]?.id, firstRunId, 'the retry must open a NEW row rather than rewriting the failed one');
      assert.equal(runs[1]?.status, 'pending', 'the retry row must be pending, not the failed row read twice');

      const jobsAfter = await countQueuedJobs();
      assert.equal(
        jobsAfter,
        2,
        `expected a second job beside the first, found ${jobsAfter}. The pg-boss singleton key blocked the ` +
          "retry: the queue's 'stately' policy should have let a second send through once the first job left " +
          "'active'.",
      );
    },
  );
});
