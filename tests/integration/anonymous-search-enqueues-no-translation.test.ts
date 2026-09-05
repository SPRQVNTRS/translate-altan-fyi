/**
 * THE WALLET TEST FOR THE TRANSLATION QUEUE. After a signed-out
 * `GET /?q=<word>`, NOTHING was queued on `translation`, ordered exactly like
 * its enrichment sibling `anonymous-search-enqueues-no-enrichment.test.ts`: the
 * anonymous request first, against a word whose translation has never been
 * queued, then the identical request with a real session, so the zero is
 * evidence only because the one beside it is real.
 *
 * WHERE THE MONEY LEAVES. `app/routes/translate.tsx`'s loader awaits
 * `resolveTriggeredTranslationPanel` for the top hit alongside the enrichment
 * panel, in one `Promise.all`, and that function's `enqueueTranslation` call
 * IS awaited before the loader returns. There is therefore no settle window
 * needed here, unlike the enrichment wallet test: by the time `search()`
 * resolves, any job it was going to queue already exists.
 *
 * THE ACCOUNT GATE RUNS BEFORE ANY OF THAT. `requireSignedIn` throws a redirect
 * at the very top of the loader, above the dictionary query and above both
 * panels, so the anonymous case below never reaches
 * `resolveTriggeredTranslationPanel` at all. A redirect assertion alone would
 * not prove that: a loader can enqueue and then redirect, and every
 * status-shaped check would stay green while a script emptied the operator's
 * budget. This file counts the row in `pgboss.job` instead.
 *
 * THE ORCHESTRATOR IS INITIALISED, AND THE WORKER IS NEVER STARTED, for the
 * reason `anonymous-search-enqueues-no-enrichment.test.ts` states in full:
 * `createWorkflowOrchestrator` registers the queues and their dedupe policy so
 * `orchestrator.start()` can succeed; it does not begin polling, which only
 * happens from `orchestrator.startWorker()`, a call this file never makes.
 *
 * ISOLATION. One headword with a run-scoped suffix, removed through
 * `tearDownTranslationFixture` in foreign-key-safe order. The queued job and
 * its workflow row are deleted by this file. Every request carries a fresh
 * documentation-range address, and its rate-limit counter is deleted by key.
 *
 * THE PRECONDITION IS A REACHABLE DATABASE. `DB_HOST`, nothing else.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { inArray, sql } from 'drizzle-orm';
import { RouterContextProvider } from 'react-router';

import { abuseCounters, workflows } from '../../drizzle/schema';
import { closePool, getRawDb, poolInitialized } from '../../drizzle/db';
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

/** `GET /?q=<lemma>`, from an address no other run shares, with or without a session. */
async function search(cookie: string | null) {
  const ip = `198.51.${octet()}.${octet()}`;
  createdCounterKeys.push(counterKey('ip', ip));
  const request = new Request(`https://kenning.altan.fyi/?q=${encodeURIComponent(lemma)}&from=${FROM}&to=${TO}`, {
    headers: cookie === null ? { 'x-forwarded-for': ip } : { 'x-forwarded-for': ip, cookie },
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

  fixture = await setUpTranslationFixture('anon-wallet');
  await initializeWorkflows();

  lemma = `zztransanon${fixture.run}`;
  headwordId = await seedHeadword(fixture, { lemma, languageCode: FROM, pos: 'noun' });
  singletonKey = translationSingletonKey({
    headwordId,
    from: FROM,
    to: TO,
    promptVersion: PROMPT_VERSION,
    runId: 'unused-the-key-drops-it',
  });

  session = await createTestUserSession('trans-anon-wallet');
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

describe('an anonymous search spends nothing on translation either', () => {
  it('queues no translation job at all', { skip: !DB_HOST ? 'DB_HOST not set' : false }, async () => {
    assert.equal(await countQueuedJobs(), 0, 'a job for this run existed before the run made one');

    const thrown = await search(null).then(
      () => null,
      (cause: unknown) => cause,
    );
    assert.ok(thrown instanceof Response, 'the anonymous search was not refused, so nothing below is a fair test');

    const jobs = await countQueuedJobs();
    assert.equal(
      jobs,
      0,
      `A signed-out GET /?q= left ${jobs} translation job(s) on the '${TRANSLATION_QUEUE}' queue. Each one is a ` +
        'paid provider call billed to the operator, for a visitor with no account. The account gate has to run ' +
        'BEFORE resolveTriggeredTranslationPanel in app/routes/translate.tsx, not after it.',
    );
  });

  it('queues exactly one for the same word once signed in', { skip: !DB_HOST ? 'DB_HOST not set' : false }, async () => {
    assert.ok(session !== null, 'the fixture account was not created, so this case would prove nothing');

    const data = await search(session.cookie);
    assert.equal(data.translationHeadwordId, headwordId, 'the signed-in search did not resolve to the seeded headword');
    assert.equal(data.translationPanel?.state, 'translating', 'the signed-in search should have started a run');

    const jobs = await countQueuedJobs();
    assert.equal(
      jobs,
      1,
      `The signed-in search left ${jobs} job(s) on the '${TRANSLATION_QUEUE}' queue, not 1. The zero asserted ` +
        'in the case above is then not evidence of a gate: this word, this queue and this process do not ' +
        'produce a job for anybody.',
    );
  });
});
