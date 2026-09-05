/**
 * THE WALLET TEST. After a signed-out `GET /?q=<word>`, NOTHING was queued.
 *
 * WHY A REDIRECT ASSERTION IS NOT THIS ASSERTION
 *   `anonymous-index-query-redirects.test.ts` proves the visitor was turned
 *   away. It does not prove the visitor was turned away BEFORE the money was
 *   spent, and those are different claims: a loader can enqueue a job and then
 *   redirect, and every status-shaped check in this milestone would stay green
 *   while the operator's OpenRouter account kept paying. This file counts the
 *   money instead of the status code.
 *
 * WHERE THE MONEY ACTUALLY LEAVES, AS OF TODAY
 *   Not in `translate.tsx` any more. M185/03 moved the decision into
 *   `app/lib/enrichment/trigger.server.ts`, which the search screen and the
 *   entry page both call: `resolveTriggeredPanel` reads the cache, and
 *   `triggerEnrichment` beneath it calls `enqueueEnrichmentInBackground`, which
 *   puts one pg-boss job on the `enrichment` queue. That job is what a worker
 *   later turns into a paid provider call. So the thing to count is a row in
 *   `pgboss.job`, and this file counts exactly that.
 *
 * THE ZERO IS ONLY EVIDENCE BECAUSE THE ONE BESIDE IT IS REAL
 *   A count of zero has two explanations: the gate worked, or nothing would
 *   have been queued anyway. The second case therefore repeats the SAME request
 *   for the SAME word with a real invited session and asserts the count is one.
 *   The cases are ordered, and the order is load-bearing: the anonymous run
 *   goes first, against a word whose enrichment has never been queued, and the
 *   signed-in run then shows that this word, on this queue, in this process,
 *   does produce a job.
 *
 * NO PROVIDER IS EVER CALLED
 *   No worker is started, so the job sits in the queue and is deleted in
 *   `after()`. The provider keys are set to a dummy for the run, only so the
 *   registry's configuration check passes and the panel is allowed to want
 *   work; their values are never used because nothing builds a client.
 *
 * ISOLATION
 *   One headword, one sense and one gloss, all carrying a run-scoped suffix and
 *   deleted in `after()` in foreign-key-safe order. Every request carries a
 *   fresh documentation-range address so the shared hourly counters cannot be
 *   read or exhausted by another run, and the counter rows are deleted by key.
 *   The account and the invite come from the shared fixture and remove
 *   themselves.
 *
 * THE PRECONDITION IS A REACHABLE DATABASE. `DB_HOST`, nothing else.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { eq, inArray, sql } from 'drizzle-orm';
import { RouterContextProvider } from 'react-router';

import { closePool, poolInitialized } from '../../drizzle/db';
import { getRawDb } from '../../drizzle/db';
import {
  abuseCounters,
  enrichments,
  headwords,
  senses,
  senseVersions,
  sources,
  translationRuns,
  workflows,
} from '../../drizzle/schema';
import { counterKey } from '../../app/lib/abuse/rate-limit.server';
import { enrichmentSingletonKey } from '../../app/lib/enrichment/enqueue.server';
import { ENRICHMENT_QUEUE } from '../../app/lib/enrichment/limits';
import { TRANSLATION_QUEUE } from '../../app/lib/translation/limits';
import { PROMPT_VERSION } from '../../app/prompts/enrichment/version';
import { loader as translateLoader } from '../../app/routes/translate';
import { initializeWorkflows, stopOrchestrator } from '../../app/services/workflows.server';
import { createTestUserSession, type TestUserSession } from '../fixtures/user-session';

const DB_HOST = process.env.DB_HOST;

const db = getRawDb();

/** Every row this run creates carries this suffix, so cleanup can be exact. */
const RUN = randomUUID().slice(0, 8);
const FROM = 'de';
const TO = 'en';

/** The provider keys, set to a dummy so the registry's configuration check passes. */
const KEY_VARS = ['OPENROUTER_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY'] as const;
const DUMMY_KEY = 'stub-key-not-a-real-credential';
const savedKeys = new Map<string, string | undefined>();

/**
 * How long a count of zero waits before it is believed.
 *
 * The enqueue is fire and forget: the loader returns before the job row lands.
 * A zero read immediately after a request would therefore be green even for a
 * request that DID queue work, which is the one way this file could lie. Both
 * cases wait the same window, so the zero and the one are measured the same way.
 */
const SETTLE_MS = 2_000;

let session: TestUserSession | null = null;
let sourceId = '';
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
  const request = new Request(`https://translate.altan.fyi/?q=${encodeURIComponent(lemma)}&from=${FROM}&to=${TO}`, {
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

/** How many pg-boss jobs carry this run's singleton key on the enrichment queue. */
async function countQueuedJobs(): Promise<number> {
  const result = await db.execute(
    sql`select count(*)::int as count from pgboss.job where name = ${ENRICHMENT_QUEUE} and singleton_key = ${singletonKey}`,
  );
  const [row] = result.rows;
  return Number(row?.count ?? 0);
}

/** How many workflow rows exist for this run's headword. `start()` writes one before it sends the job. */
async function countWorkflowRows(): Promise<number> {
  const result = await db.execute(
    sql`select count(*)::int as count from workflows where context->>'headwordId' = ${headwordId}`,
  );
  const [row] = result.rows;
  return Number(row?.count ?? 0);
}

function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
}

before(async () => {
  if (!DB_HOST) return;

  for (const name of KEY_VARS) {
    savedKeys.set(name, process.env[name]);
    process.env[name] = DUMMY_KEY;
  }

  // Registers the templates so `start()` can resolve `enrich-headword` and
  // reach `boss.send`. The WORKER is deliberately not started: the point is to
  // count queued jobs, not to run one, and a running worker would both drain
  // the queue under the assertions and call a provider.
  await initializeWorkflows();

  const [source] = await db
    .insert(sources)
    .values({ slug: `zzwallet-${RUN}`, name: `wallet test ${RUN}`, licence: 'CC0-1.0', attribution: `wallet test ${RUN}` })
    .returning({ id: sources.id });
  assert.ok(source, 'failed to create the test source');
  sourceId = source.id;

  lemma = `zzwallet${RUN}`;
  const [headword] = await db
    .insert(headwords)
    .values({ languageCode: FROM, lemma, lemmaNormalized: lemma, pos: 'noun', sourceId })
    .returning({ id: headwords.id });
  assert.ok(headword, 'failed to create the test headword');
  headwordId = headword.id;

  const [sense] = await db
    .insert(senses)
    .values({ headwordId, sourceId, externalId: `${lemma}-s0` })
    .returning({ id: senses.id });
  assert.ok(sense, 'failed to create the test sense');
  await db.insert(senseVersions).values({
    senseId: sense.id,
    version: 1,
    glossLanguageCode: TO,
    gloss: `test gloss for ${lemma}`,
    sourceId,
  });

  singletonKey = enrichmentSingletonKey({ headwordId, from: FROM, to: TO, promptVersion: PROMPT_VERSION });
  session = await createTestUserSession('wallet');
});

after(async () => {
  if (DB_HOST) {
    await stopOrchestrator();
    await db.execute(sql`delete from pgboss.job where name = ${ENRICHMENT_QUEUE} and singleton_key like ${`${headwordId}:%`}`);
    // THE SIGNED-IN CASE NOW STARTS A TRANSLATION RUN AS WELL (M193/02). The
    // search loader triggers both panels for the top hit, so the signed-in
    // request below leaves a queued `translate-headword` job and a
    // `translation_runs` row behind it. The run row REFERENCES the headword,
    // so leaving it here does not merely litter: the headword delete at the
    // foot of this block would wait on it and the run would read as hung.
    await db.execute(sql`delete from pgboss.job where name = ${TRANSLATION_QUEUE} and singleton_key like ${`${headwordId}:%`}`);
    await db.delete(translationRuns).where(eq(translationRuns.headwordId, headwordId));
    await db.delete(workflows).where(sql`${workflows.context}->>'headwordId' = ${headwordId}`);
    if (createdCounterKeys.length > 0) {
      await db.delete(abuseCounters).where(inArray(abuseCounters.key, createdCounterKeys));
    }
    // FOREIGN-KEY-SAFE ORDER, and it is not optional: the versions point at the
    // senses, the senses point at the headword, and everything points at the
    // source. Deleting the headword first waits on a lock rather than failing,
    // which reads as a hung test run rather than as a mistake.
    if (sourceId !== '') {
      await db.delete(enrichments).where(inArray(enrichments.headwordId, [headwordId]));
      await db.delete(senseVersions).where(eq(senseVersions.sourceId, sourceId));
      await db.delete(senses).where(eq(senses.sourceId, sourceId));
      await db.delete(headwords).where(eq(headwords.sourceId, sourceId));
      await db.delete(sources).where(eq(sources.id, sourceId));
    }
  }
  if (session !== null) await session.dispose();
  for (const [name, value] of savedKeys) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  // THE POOL FINISHES OPENING BEFORE IT IS CLOSED. `drizzle/db.ts` kicks off
  // `ensureHostIndexes` behind `poolInitialized` at import time, and a short
  // test file can reach `closePool()` first, which turns a passing run into
  // "Cannot use a pool after calling end on the pool" reported as a failure.
  await poolInitialized;
  await closePool();
});

describe('an anonymous search spends nothing', () => {
  it('queues no enrichment job at all', { skip: !DB_HOST ? 'DB_HOST not set' : false }, async () => {
    // Counted before, so the assertion below is about THIS request and not
    // about the state the database happened to be in.
    assert.equal(await countQueuedJobs(), 0, 'a job for this run existed before the run made one');

    const thrown = await search(null).then(
      () => null,
      (cause: unknown) => cause,
    );
    assert.ok(thrown instanceof Response, 'the anonymous search was not refused, so nothing below is a fair test');

    await settle();

    const jobs = await countQueuedJobs();
    assert.equal(
      jobs,
      0,
      `A signed-out GET /?q= left ${jobs} enrichment job(s) on the '${ENRICHMENT_QUEUE}' queue. Each one is a ` +
        "paid provider call billed to the operator, for a visitor with no account. The gate has to run BEFORE " +
        'resolveTriggeredPanel in app/routes/translate.tsx, not after it: a redirect issued after an enqueue ' +
        'still costs money and still looks correct from the outside.',
    );

    const rows = await countWorkflowRows();
    assert.equal(
      rows,
      0,
      `A signed-out GET /?q= left ${rows} workflow row(s) for this headword. start() writes the workflow row ` +
        'BEFORE it sends the job, so a non-zero count here means the enqueue was reached even if the job ' +
        'itself was deduped away.',
    );
  });

  it('queues exactly one for the same word once signed in', { skip: !DB_HOST ? 'DB_HOST not set' : false }, async () => {
    // THE MEASUREMENT CHAIN. Without this case the zero above is unfalsifiable:
    // a loader that queued nothing for anybody, a queue that dropped every
    // send, or a word nothing would ever enrich would all read as success.
    assert.ok(session !== null, 'the fixture account was not created, so this case would prove nothing');

    const data = await search(session.cookie);
    assert.equal(data.hits[0]?.headwordId, headwordId, 'the signed-in search did not find the seeded word');

    await settle();

    const jobs = await countQueuedJobs();
    assert.equal(
      jobs,
      1,
      `The signed-in search left ${jobs} job(s) on the '${ENRICHMENT_QUEUE}' queue, not 1. The zero asserted in ` +
        'the case above is then not evidence of a gate: this word, this queue and this process do not produce a ' +
        'job for anybody. Check that a provider is reported as configured and that the enrichment queue exists.',
    );
  });
});
