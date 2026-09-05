/**
 * THE BUG THIS FILE WOULD HAVE CAUGHT. A German headword with ZERO senses,
 * searched by a signed-in reader, must land exactly one job on the
 * `translation` queue and leave the pane in `translating`. With the old
 * zero-sense short circuit still in place (`state.server.ts:293`, before
 * M193), the count here is zero: a headword with no sense could never grow a
 * translation however many readers asked for one, and about 93% of the German
 * headwords in this dictionary are in that state. `resolveTriggeredTranslationPanel`
 * is the function M193/02 wrote to remove that short circuit, and this is the
 * one case that would fail if it ever crept back in.
 *
 * THE SEARCH LOADER IS THE SUBJECT, exactly as
 * `inline-enrichment-panel-resolves.test.ts` calls `app/routes/translate.tsx`'s
 * own loader rather than `resolveTriggeredTranslationPanel` underneath it. A
 * test against the resolver alone would stay green if the search route stopped
 * wiring the translation panel into its response at all.
 *
 * THE ENQUEUE IS AWAITED, SO THERE IS NO SETTLE WINDOW. Unlike the enrichment
 * trigger, `resolveTriggeredTranslationPanel` awaits `enqueueTranslation`
 * before the loader returns, so the job row exists the moment the loader call
 * resolves. `anonymous-search-enqueues-no-enrichment.test.ts` needs a settle
 * window for exactly the opposite reason: its enqueue is fire-and-forget.
 *
 * THE ORCHESTRATOR IS INITIALISED, AND THE WORKER IS NEVER STARTED.
 * `initializeWorkflows()` calls `createWorkflowOrchestrator`, which registers
 * the queues and their `stately` dedupe policy so `orchestrator.start()` can
 * succeed; it does not begin polling. Polling only starts from
 * `orchestrator.startWorker()`, which lives behind `startWorkflowWorker()` in
 * `app/services/workflows.server.ts` and is never called here or by anything
 * this file imports. `anonymous-search-enqueues-no-enrichment.test.ts` proves
 * the same thing in its own file comment: "The WORKER is deliberately not
 * started." No provider is ever reached from this file.
 *
 * ISOLATION. The headword carries a run-scoped suffix and is removed, in
 * foreign-key-safe order, through `tearDownTranslationFixture`, which also
 * restores the shared `daily_budget` row. The queued job and its workflow row
 * are deleted by this file, because the fixture only knows about dictionary
 * tables. Every request carries a fresh documentation-range address, and its
 * rate-limit counter is deleted by key.
 *
 * THE PRECONDITION IS A REACHABLE DATABASE. `DB_HOST`, nothing else.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { inArray, sql } from 'drizzle-orm';
import { RouterContextProvider } from 'react-router';

import { abuseCounters, workflows } from '../../drizzle/schema';
import { getRawDb, closePool, poolInitialized } from '../../drizzle/db';
import { counterKey } from '../../app/lib/abuse/rate-limit.server';
import { translationSingletonKey } from '../../app/lib/translation/job-payload';
import { TRANSLATION_QUEUE } from '../../app/lib/translation/limits';
import { PROMPT_VERSION } from '../../app/prompts/translation/version';
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

const createdCounterKeys: string[] = [];

/** One octet of a documentation-range address. */
function octet(): number {
  return 1 + Math.floor(Math.random() * 250);
}

async function search() {
  const ip = `198.51.${octet()}.${octet()}`;
  createdCounterKeys.push(counterKey('ip', ip));
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

  fixture = await setUpTranslationFixture('zero-sense-one');
  session = await createTestUserSession('trans-zero-one');
  await initializeWorkflows();

  lemma = `zztranszero${fixture.run}`;
  headwordId = await seedHeadword(fixture, { lemma, languageCode: FROM, pos: 'noun' });
  singletonKey = translationSingletonKey({
    headwordId,
    from: FROM,
    to: TO,
    promptVersion: PROMPT_VERSION,
    runId: 'unused-the-key-drops-it',
  });
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

describe('a signed-in search on a headword with zero senses', () => {
  it(
    'enqueues exactly one translation job and leaves the pane translating',
    { skip: !DB_HOST ? 'DB_HOST not set' : false },
    async () => {
      assert.ok(session !== null, 'the fixture account was not created, so this case would prove nothing');

      const jobsBefore = await countQueuedJobs();
      assert.equal(jobsBefore, 0, 'a job for this key already existed before the search ran');

      const data = await search();
      assert.equal(data.translationHeadwordId, headwordId, 'the search did not resolve to the seeded headword');
      assert.equal(
        data.translationPanel?.state,
        'translating',
        `expected the panel to be translating, got ${JSON.stringify(data.translationPanel)}. With the old ` +
          'zero-sense short circuit back in place, a headword with no senses never reaches the enqueue at all.',
      );

      const jobs = await countQueuedJobs();
      assert.equal(
        jobs,
        1,
        `the signed-in search left ${jobs} job(s) on the '${TRANSLATION_QUEUE}' queue for this headword, not 1`,
      );
    },
  );
});
