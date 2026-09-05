/**
 * THE PHRASE CLAIM: ASKED ONCE, ANSWERED FOREVER. A typed sentence queues
 * exactly one job for one direction and one folded text, and the second reader
 * typing the same sentence adds no job, opens no row and moves no money.
 *
 * WHAT THIS FILE HOLDS IN PLACE
 *   1. ONE JOB PER KEY. The phrase job shares the `translation` queue with the
 *      word job, whose `stately` policy is what makes a singleton key bite at
 *      all. A second job for one key is a second paid call for a sentence this
 *      installation has already asked about.
 *   2. ONE ROW PER KEY. The enqueue opens a `pending` row BEFORE it queues, so a
 *      duplicate request has already written one. That row must not survive: the
 *      pane reads the LATEST row for a key, so a leftover would be newer than
 *      the running job's and the reader would be shown the wrong state.
 *   3. THE ANSWER IS SERVED FROM THE ROW. Once a run has written its text, the
 *      resolver reads it and returns `ready` before either counter is touched,
 *      so the second reader spends nothing.
 *   4. NOTHING REACHES THE DICTIONARY. The four tables the word job writes are
 *      counted before and after a phrase run, and neither count moves. A
 *      sentence in them would poison every query M193 built.
 *
 *   This file must not be made green by weakening an assertion.
 *
 * NO WORKER IS STARTED. `initializeWorkflows()` registers the templates so
 * `start()` can resolve `translate-phrase` and reach `boss.send`; the worker is
 * deliberately left down, because a running one would drain the queue underneath
 * the assertions. The one run this file executes is driven directly, through
 * `runTranslatePhrase`, against a faked provider port.
 *
 * NO LIVE API IS EVER REACHABLE. `setUpTranslationFixture` installs the fake
 * port and dummy keys, so no real client is ever built.
 *
 * ISOLATION. Every sentence carries a run-scoped suffix; the phrase rows, the
 * queue jobs, the workflow rows and the rate-limit counters this file causes are
 * all removed by key, and today's budget figures are restored by the fixture.
 *
 * THE PRECONDITION IS A REACHABLE DATABASE. `DB_HOST`, nothing else.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { count, eq, inArray, like, sql } from 'drizzle-orm';

import { getRawDb, pool } from '../../drizzle/db';
import {
  abuseCounters,
  dailyBudget,
  headwords,
  phraseTranslations,
  senses,
  translations,
  workflows,
} from '../../drizzle/schema';
import { utcDay } from '../../app/lib/abuse/budget.server';
import { counterKey } from '../../app/lib/abuse/rate-limit.server';
import { TRANSLATION_QUEUE } from '../../app/lib/translation/limits';
import { phraseSingletonKey } from '../../app/lib/translation/phrase-job-payload';
import { resolveTriggeredPhrasePanel } from '../../app/lib/translation/phrase-panel.server';
import { createPendingPhrase } from '../../app/models/phrase-runs.server';
import { getActiveModel } from '../../app/models/app-settings.server';
import { PHRASE_PROMPT_VERSION } from '../../app/prompts/phrase/version';
import { initializeWorkflows, stopOrchestrator } from '../../app/services/workflows.server';
import { runTranslatePhrase } from '../../app/workflows/operations/translation/translate-phrase';
import { createFakeLlmPort, llmValue } from '../fixtures/fake-llm-port';
import {
  setUpTranslationFixture,
  tearDownTranslationFixture,
  type TranslationFixture,
} from '../fixtures/translation-corpus';

const DB_HOST = process.env.DB_HOST;

const db = getRawDb();

const FROM = 'de';
const TO = 'tr';

/** The Turkish sentence the fake model answers with. */
const ANSWER = 'Arabayi depoya kadar doldur';

let fixture: TranslationFixture = {
  sourceId: '',
  generatedSourceId: '',
  fake: createFakeLlmPort(),
  run: '',
  seededHeadwordIds: [],
};

/** The sentence the queue cases use, and its folded form. */
let queued = { text: '', normalized: '', singletonKey: '' };
/** The sentence the cache case uses. It never reaches the queue. */
let cached = { text: '', normalized: '' };

const createdCounterKeys: string[] = [];

/** One octet of a documentation-range address. */
function octet(): number {
  return 1 + Math.floor(Math.random() * 250);
}

/**
 * One search, from a fresh address so the rate limiter is never the reason a
 * case goes red.
 */
async function search(phrase: { text: string; normalized: string }) {
  const ip = `198.51.${octet()}.${octet()}`;
  createdCounterKeys.push(counterKey('ip', ip));
  const request = new Request(`https://kenning.altan.fyi/?q=${encodeURIComponent(phrase.text)}`, {
    headers: { 'x-forwarded-for': ip },
  });
  return resolveTriggeredPhrasePanel(db, {
    sourceText: phrase.text,
    sourceNormalized: phrase.normalized,
    from: FROM,
    to: TO,
    request,
  });
}

async function countJobs(singletonKey: string): Promise<number> {
  const result = await db.execute(
    sql`select count(*)::int as count from pgboss.job where name = ${TRANSLATION_QUEUE} and singleton_key = ${singletonKey}`,
  );
  const [row] = result.rows;
  return Number(row?.count ?? 0);
}

/** Every row that exists for one folded sentence, whatever its status. */
async function rowsFor(normalized: string) {
  return db
    .select({ id: phraseTranslations.id, status: phraseTranslations.status, text: phraseTranslations.translationText })
    .from(phraseTranslations)
    .where(eq(phraseTranslations.sourceNormalized, normalized));
}

/** Today's committed total, `reserved + spent`, so a move of either half is caught. */
async function committedToday(): Promise<number> {
  const [row] = await db
    .select({ reservedUsd: dailyBudget.reservedUsd, spentUsd: dailyBudget.spentUsd })
    .from(dailyBudget)
    .where(eq(dailyBudget.day, utcDay(new Date())));
  if (!row) return 0;
  return Number(row.reservedUsd) + Number(row.spentUsd);
}

/** How many rows the three dictionary tables hold right now. */
async function dictionarySize(): Promise<{ headwords: number; senses: number; edges: number }> {
  const [h] = await db.select({ total: count() }).from(headwords);
  const [s] = await db.select({ total: count() }).from(senses);
  const [t] = await db.select({ total: count() }).from(translations);
  return { headwords: h?.total ?? 0, senses: s?.total ?? 0, edges: t?.total ?? 0 };
}

before(async () => {
  if (!DB_HOST) return;
  fixture = await setUpTranslationFixture('phrase');
  const text = `zzsatz ${fixture.run} das auto volltanken`;
  queued = {
    text,
    normalized: text,
    singletonKey: phraseSingletonKey({
      from: FROM,
      to: TO,
      sourceNormalized: text,
      promptVersion: PHRASE_PROMPT_VERSION,
      runId: 'unused-the-key-drops-it',
    }),
  };
  const cachedText = `zzgecache ${fixture.run} das auto volltanken`;
  cached = { text: cachedText, normalized: cachedText };
  // Registers the templates so `start()` can resolve `translate-phrase`. The
  // WORKER is deliberately not started.
  await initializeWorkflows();
});

after(async () => {
  if (!DB_HOST) {
    await pool.end();
    return;
  }
  await stopOrchestrator();
  if (createdCounterKeys.length > 0) {
    await db.delete(abuseCounters).where(inArray(abuseCounters.key, createdCounterKeys));
  }
  await db.delete(workflows).where(sql`${workflows.context}->>'sourceNormalized' like ${`zz%${fixture.run}%`}`);
  await db.execute(
    sql`delete from pgboss.job where name = ${TRANSLATION_QUEUE} and singleton_key like ${`phrase:%${fixture.run}%`}`,
  );
  await db.delete(phraseTranslations).where(like(phraseTranslations.sourceNormalized, `zz%${fixture.run}%`));
  await tearDownTranslationFixture(fixture, []);
  await pool.end();
});

describe('a phrase search', () => {
  it(
    'queues exactly one job and opens exactly one row, and a second search of the same sentence adds neither',
    { skip: !DB_HOST ? 'DB_HOST not set' : false },
    async () => {
      const first = await search(queued);
      assert.deepEqual(first, { state: 'translating' }, 'the first search did not start a run');

      const jobsAfterFirst = await countJobs(queued.singletonKey);
      assert.equal(jobsAfterFirst, 1, `the first search left ${jobsAfterFirst} job(s) on the queue for one key`);

      const budgetAfterFirst = await committedToday();

      const second = await search(queued);
      assert.deepEqual(second, { state: 'translating' }, 'the second search did not read the open run');

      const jobsAfterSecond = await countJobs(queued.singletonKey);
      assert.equal(
        jobsAfterSecond,
        1,
        `two searches of one sentence left ${jobsAfterSecond} job(s). Each extra job is a paid model call for a ` +
          'sentence this installation has already asked about.',
      );

      const rows = await rowsFor(queued.normalized);
      assert.equal(
        rows.length,
        1,
        `${rows.length} rows exist for one key. The pane reads the LATEST row, so a leftover is a reader shown the ` +
          'state of a run nobody is working on.',
      );
      assert.equal(rows[0]?.status, 'pending');

      assert.equal(
        await committedToday(),
        budgetAfterFirst,
        'a second search of an open sentence must not reserve or spend a cent',
      );
    },
  );

  it(
    'is served from the row once it has been answered, spending nothing and touching no dictionary table',
    { skip: !DB_HOST ? 'DB_HOST not set' : false },
    async () => {
      const active = await getActiveModel();
      const runId = await createPendingPhrase(db, {
        from: FROM,
        to: TO,
        sourceText: cached.text,
        sourceNormalized: cached.normalized,
        promptVersion: PHRASE_PROMPT_VERSION,
        provider: active.provider,
        model: active.model,
      });

      const dictionaryBefore = await dictionarySize();
      fixture.fake.reset([llmValue({ translation: ANSWER })]);
      const summary = await runTranslatePhrase({
        from: FROM,
        to: TO,
        sourceNormalized: cached.normalized,
        promptVersion: PHRASE_PROMPT_VERSION,
        runId,
      });
      assert.equal(summary.outcome, 'written', summary.reason ?? '');

      // THE PROMPT CARRIES THE TEXT AS TYPED, not the folded cache key. A model
      // shown the folded form would answer a different question, and a question
      // mark the reader typed would be gone from the answer.
      assert.ok(
        fixture.fake.calls[0]?.prompt.includes(cached.text),
        'the model was not shown the text the reader typed',
      );

      assert.deepEqual(
        await dictionarySize(),
        dictionaryBefore,
        'a phrase run wrote a dictionary row. A sentence is not a lexical edge, and one in those tables poisons ' +
          'every query the generated corpus is read by.',
      );

      const budgetBefore = await committedToday();
      const panel = await search(cached);
      assert.equal(panel.state, 'ready', `expected the answered sentence to be served, got ${JSON.stringify(panel)}`);
      assert.equal(panel.state === 'ready' ? panel.translations.length : 0, 1);
      assert.equal(panel.state === 'ready' ? panel.translations[0]?.lemma : null, ANSWER);
      assert.equal(panel.state === 'ready' ? panel.translations[0]?.pos : 'unset', null);
      assert.equal(panel.state === 'ready' ? panel.translations[0]?.generated : false, true);

      assert.equal(
        await countJobs(
          phraseSingletonKey({
            from: FROM,
            to: TO,
            sourceNormalized: cached.normalized,
            promptVersion: PHRASE_PROMPT_VERSION,
            runId: 'unused',
          }),
        ),
        0,
        'a sentence the table already answers must never reach the queue',
      );
      assert.equal(
        await committedToday(),
        budgetBefore,
        'a sentence the table already answers must never reserve or spend a cent',
      );

      const rows = await rowsFor(cached.normalized);
      assert.equal(rows.length, 1);
      assert.equal(rows[0]?.status, 'ok');
      assert.equal(rows[0]?.text, ANSWER);
    },
  );

  it(
    'writes no row that a later attempt would have to step over when a guard refuses',
    { skip: !DB_HOST ? 'DB_HOST not set' : false },
    async () => {
      const tooLong = `zzlang ${fixture.run} ${'a'.repeat(400)}`;
      const rowsBefore = await rowsFor(tooLong);
      assert.equal(rowsBefore.length, 0);

      const panel = await search({ text: tooLong, normalized: tooLong });
      assert.deepEqual(panel, { state: 'budget', reason: 'too-long' });

      const rowsAfter = await rowsFor(tooLong);
      assert.equal(
        rowsAfter.length,
        0,
        'a refusal opened a row. The pane reads the LATEST row, so a refused attempt would hide every later one.',
      );
    },
  );
});
