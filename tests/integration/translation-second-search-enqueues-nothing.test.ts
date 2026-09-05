/**
 * THE CORPUS CLAIM: STORED ONCE, SERVED FOREVER. Once a translation run has
 * written its rows for a pair, a second search for the same word must add no
 * job and move no money, because `resolveTranslationPanel` reads the corpus
 * FIRST and answers `ready` outright before either guard is ever asked
 * anything.
 *
 * THE SEARCH LOADER IS THE SUBJECT, exactly like the other files in this set:
 * the claim is about what a reader searching again actually gets, not about
 * the resolver underneath the route.
 *
 * NO ORCHESTRATOR IS EVER TOUCHED. A `ready` pair never reaches
 * `enqueueTranslation`, so this file never calls `initializeWorkflows()` and
 * has no queue to clean up. That absence is itself part of the claim: if a
 * future change moved the corpus check below the guards, this file would need
 * a worker to stay honest, which is a smell the file's own imports would make
 * visible.
 *
 * NO LIVE API IS EVER REACHABLE. The first run, which is what SEEDS the ready
 * state, is executed directly against a fake port through
 * `setUpTranslationFixture`.
 *
 * ISOLATION. Every row carries a run-scoped suffix and is removed, in
 * foreign-key-safe order, through `tearDownTranslationFixture`, and today's
 * `daily_budget` figures are read before the search under test and compared
 * after it, then put back to what they were before this file ran at all.
 * Every request carries a fresh documentation-range address.
 *
 * THE PRECONDITION IS A REACHABLE DATABASE. `DB_HOST`, nothing else.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { eq, inArray, sql } from 'drizzle-orm';
import { RouterContextProvider } from 'react-router';

import { getRawDb, pool } from '../../drizzle/db';
import { abuseCounters, dailyBudget } from '../../drizzle/schema';
import { utcDay } from '../../app/lib/abuse/budget.server';
import { counterKey } from '../../app/lib/abuse/rate-limit.server';
import { getActiveModel } from '../../app/models/app-settings.server';
import { createPendingRun } from '../../app/models/translation-runs.server';
import { translationSingletonKey } from '../../app/lib/translation/job-payload';
import { TRANSLATION_QUEUE } from '../../app/lib/translation/limits';
import { PROMPT_VERSION } from '../../app/prompts/translation/version';
import { loader as translateLoader } from '../../app/routes/translate';
import { runTranslateHeadword } from '../../app/workflows/operations/translation/translate-headword';
import { createFakeLlmPort, llmValue } from '../fixtures/fake-llm-port';
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

const runIds: string[] = [];
const createdCounterKeys: string[] = [];

let headwordId = '';
let lemma = '';
let targetLemma = '';
let singletonKey = '';

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

/** Today's committed total, `reserved + spent`, so a move of either half is caught. */
async function committedToday(): Promise<number> {
  const day = utcDay(new Date());
  const [row] = await db
    .select({ reservedUsd: dailyBudget.reservedUsd, spentUsd: dailyBudget.spentUsd })
    .from(dailyBudget)
    .where(eq(dailyBudget.day, day));
  if (!row) return 0;
  return Number(row.reservedUsd) + Number(row.spentUsd);
}

before(async () => {
  if (!DB_HOST) return;
  fixture = await setUpTranslationFixture('second-search');
  session = await createTestUserSession('trans-second-search');
  lemma = `zztranstwice${fixture.run}`;
  targetLemma = `zzhedeftwice${fixture.run}`;
  headwordId = await seedHeadword(fixture, { lemma, languageCode: FROM, pos: 'verb' });
  singletonKey = translationSingletonKey({
    headwordId,
    from: FROM,
    to: TO,
    promptVersion: PROMPT_VERSION,
    runId: 'unused-the-key-drops-it',
  });

  // SEED THE READY STATE FOR REAL, the same way `translation-run-yields-ready`
  // does: a run executed directly, with no queue and no worker in the loop.
  const active = await getActiveModel();
  const runId = await createPendingRun(db, {
    headwordId,
    from: FROM,
    to: TO,
    promptVersion: PROMPT_VERSION,
    provider: active.provider,
    model: active.model,
  });
  runIds.push(runId);
  fixture.fake.reset([
    llmValue({
      senses: [
        {
          localId: 's1',
          pos: 'verb',
          gloss: 'zweimal etwas tun',
          translations: [{ lemma: targetLemma, pos: 'verb', confidence: 'high' }],
        },
      ],
    }),
  ]);
  const summary = await runTranslateHeadword({ headwordId, from: FROM, to: TO, promptVersion: PROMPT_VERSION, runId });
  assert.equal(summary.outcome, 'written', summary.reason ?? '');
});

after(async () => {
  if (!DB_HOST) {
    await pool.end();
    return;
  }
  if (createdCounterKeys.length > 0) {
    await db.delete(abuseCounters).where(inArray(abuseCounters.key, createdCounterKeys));
  }
  await tearDownTranslationFixture(fixture, runIds);
  if (session !== null) await session.dispose();
  await pool.end();
});

describe('a second search on a pair the corpus already answers', () => {
  it(
    'adds no job and moves no budget',
    { skip: !DB_HOST ? 'DB_HOST not set' : false },
    async () => {
      assert.ok(session !== null, 'the fixture account was not created, so this case would prove nothing');

      const jobsBefore = await db.execute(
        sql`select count(*)::int as count from pgboss.job where name = ${TRANSLATION_QUEUE} and singleton_key = ${singletonKey}`,
      );
      const budgetBefore = await committedToday();

      const data = await search();
      assert.equal(
        data.translationPanel?.state,
        'ready',
        `expected the second search to read the corpus, got ${JSON.stringify(data.translationPanel)}`,
      );

      const jobsAfter = await db.execute(
        sql`select count(*)::int as count from pgboss.job where name = ${TRANSLATION_QUEUE} and singleton_key = ${singletonKey}`,
      );
      assert.equal(
        jobsAfter.rows[0]?.count,
        jobsBefore.rows[0]?.count,
        'a search on a pair the corpus already answers must never reach the queue',
      );

      const budgetAfter = await committedToday();
      assert.equal(
        budgetAfter,
        budgetBefore,
        'a search on a pair the corpus already answers must never reserve or spend a cent',
      );
    },
  );
});
