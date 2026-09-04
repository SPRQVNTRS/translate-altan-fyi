/**
 * Ten concurrent enqueues for one headword must produce ONE queued job.
 *
 * WHAT THIS FILE HOLDS IN PLACE
 *   Enrichment runs on its OWN pg-boss queue, `enrichment`, carrying the
 *   `stately` policy. Both halves of that sentence are load-bearing, and the
 *   chain below is why. Read it before you treat a failure here as a flake: a
 *   red case in this file is a real defect, and it costs money.
 *
 *   1. In pg-boss 10.4.2 the unique indexes that make `singleton_key` mean
 *      anything are ALL policy-gated (src/plans.js, `job_i1` needs policy
 *      `short`, `job_i2` needs `singleton`, `job_i3` needs `stately`, and
 *      `job_i4` covers throttling by `singleton_on`, which is a different
 *      feature). Under the default `standard` policy no index covers the
 *      column, so the key is stored and enforces nothing.
 *   2. `insertJob` ends in `ON CONFLICT DO NOTHING`, so with no constraint to
 *      conflict on there is nothing to swallow. Every send returns an id,
 *      `start()` never sees a null, and the `deduped` branch in
 *      `enqueueEnrichment` can never fire. Ten enqueues make ten jobs, and ten
 *      workers make ten paid provider calls, because they can all read an empty
 *      cache before any of them writes to it.
 *   3. `@sprqvntrs/workflows` 0.2.5 creates every queue with
 *      `boss.createQueue(name)` and no options (src/orchestrator.ts, lines 547
 *      and 567), so the library cannot set a policy. `create_queue` is itself
 *      `ON CONFLICT DO NOTHING` (plans.js), so a queue that already exists keeps
 *      the policy it has, and a restart cannot repair one either.
 *
 *   `app/services/workflows.server.ts` therefore forces the policy itself, with
 *   `createQueue` AND `updateQueue`, and enrichment gets a queue of its own so
 *   that policy does not change dedupe semantics for every other workflow.
 *
 *   `stately` rather than `short`: `short` only dedupes jobs still in `created`,
 *   so a second enqueue arriving after the first goes active queues a second job
 *   and both pay. `stately` is unique per (queue, state, key) for every state up
 *   to `active`, so there can never be two ACTIVE runs for one key.
 *
 *   This file must not be made green by weakening an assertion.
 *
 * NO PROVIDER IS INVOLVED HERE AT ALL, so no fake port is installed and no
 * worker is started. The "one provider call" half of the spec's sentence is
 * already proven by case 1 of `enrichment-workflow.test.ts`, which asserts
 * `providerCalls === 1` for one run and `0` for a cached one. This file owns the
 * other half, which is the job count.
 *
 * THE PRECONDITION IS A REACHABLE DATABASE
 *   `DB_HOST` and the other `DB_*` variables, nothing else. Every case gates on
 *   `DB_HOST` alone, which `tests/unit/integration-tests-self-skip.test.ts`
 *   enforces.
 *
 * ISOLATION
 *   The headword id is a fresh random UUID per run, so the singleton key cannot
 *   collide with anything real. The headword does not need to exist: no worker
 *   runs, so nothing ever dereferences it. Every workflow row and every pg-boss
 *   job this file creates is deleted in `after()`, including the orphan workflow
 *   rows that `start()` leaves behind when it dedupes, because it inserts the
 *   workflow row BEFORE it sends the job.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';

import { pool } from '../../drizzle/db';
import { getRawDb } from '../../drizzle/db';
import { workflows } from '../../drizzle/schema';
import {
  enqueueEnrichment,
  enrichmentSingletonKey,
  type EnrichmentJobPayload,
} from '../../app/lib/enrichment/enqueue.server';
import { ENRICHMENT_QUEUE } from '../../app/lib/enrichment/limits';
import { PROMPT_VERSION } from '../../app/prompts/enrichment/version';
import { initializeWorkflows, stopOrchestrator } from '../../app/services/workflows.server';
import { enrichHeadwordTemplate } from '../../app/workflows/templates/enrich-headword';

const DB_HOST = process.env.DB_HOST;

const db = getRawDb();

/** How many enqueues race. The spec's number, and the reason this file exists. */
const BURST_SIZE = 10;

/**
 * A headword id that exists nowhere. The enqueue never dereferences it, and a
 * value drawn fresh per run means this file cannot dedupe against a job some
 * other run left in the queue.
 */
const HEADWORD_ID = randomUUID();

const payload: EnrichmentJobPayload = {
  headwordId: HEADWORD_ID,
  from: 'de',
  to: 'en',
  promptVersion: PROMPT_VERSION,
};

/** The same headword under a later prompt version, which must NOT be deduped away. */
const nextVersionPayload: EnrichmentJobPayload = {
  ...payload,
  promptVersion: PROMPT_VERSION + 1,
};

/** The dedicated enrichment queue. The job rows are counted against it. */
const QUEUE = ENRICHMENT_QUEUE;

/** How many pg-boss jobs carry one singleton key on the template's queue. */
async function countJobs(singletonKey: string): Promise<number> {
  const result = await db.execute(
    sql`select count(*)::int as count from pgboss.job where name = ${QUEUE} and singleton_key = ${singletonKey}`,
  );
  const [row] = result.rows;
  return Number(row?.count ?? 0);
}

/** The policy the queue was created with, or null when the queue does not exist yet. */
async function readQueuePolicy(): Promise<string | null> {
  const result = await db.execute(
    sql`select policy from pgboss.queue where name = ${QUEUE}`,
  );
  const [row] = result.rows;
  return row?.policy === undefined || row.policy === null ? null : String(row.policy);
}

/**
 * The policy the enrichment queue must carry. `short` and `singleton` also cover
 * `singleton_key` with an index, but only `stately` bars a SECOND ACTIVE run for
 * one key, and that is the guarantee that protects the money.
 */
const REQUIRED_POLICY = 'stately';

before(async () => {
  if (!DB_HOST) return;

  // The honest path: this registers the templates, so `start()` can resolve
  // `enrich-headword` and reach `boss.send`. The WORKER is deliberately not
  // started. The point is to count queued jobs, not to run one, and a running
  // worker would drain the queue underneath the assertions.
  await initializeWorkflows();
});

after(async () => {
  if (!DB_HOST) {
    await pool.end();
    return;
  }

  await stopOrchestrator();

  // Both payloads share the headword id, so one predicate reaches every row and
  // every job this file created, however many of them there turned out to be.
  await db.delete(workflows).where(sql`${workflows.context}->>'headwordId' = ${HEADWORD_ID}`);
  await db.execute(
    sql`delete from pgboss.job where name = ${QUEUE} and singleton_key like ${`${HEADWORD_ID}:%`}`,
  );

  await pool.end();
});

describe('enrichment enqueue dedupe', () => {
  it('runs enrichment on a queue whose policy makes a singleton key bite', { skip: !DB_HOST ? 'DB_HOST not set' : false }, async () => {
    // This case runs first ON PURPOSE. It is the root cause of the next one, and
    // reading a red burst as "the burst is racy" would send the reader hunting
    // for a race that is not there.
    assert.equal(
      enrichHeadwordTemplate.queue,
      QUEUE,
      `the enrich-headword template sends to '${enrichHeadwordTemplate.queue}', not the dedicated '${QUEUE}' queue, ` +
        'so the policy asserted below does not govern its jobs',
    );

    const policy = await readQueuePolicy();

    assert.ok(policy !== null, `the pg-boss queue '${QUEUE}' does not exist, so nothing was enqueued`);
    assert.equal(
      policy,
      REQUIRED_POLICY,
      `The pg-boss queue '${QUEUE}' has policy '${policy}', not '${REQUIRED_POLICY}'. In pg-boss 10.4.2 every unique ` +
        'index over singleton_key is policy-gated (job_i1 short, job_i2 singleton, job_i3 stately), and only ' +
        'stately is unique per (queue, state, key) for every state up to active, which is what bars a second ' +
        'ACTIVE run for one key. @sprqvntrs/workflows 0.2.5 calls boss.createQueue(name) with no options, and ' +
        'create_queue is ON CONFLICT DO NOTHING, so the policy can only come from the explicit createQueue plus ' +
        'updateQueue pair in initializeWorkflows. If this is red, that wiring is gone or the queue predates it.',
    );
  });

  it('turns a concurrent burst into exactly one queued job', { skip: !DB_HOST ? 'DB_HOST not set' : false }, async () => {
    const singletonKey = enrichmentSingletonKey(payload);

    const outcomes = await Promise.all(
      Array.from({ length: BURST_SIZE }, () => enqueueEnrichment(payload)),
    );

    // THE JOB COUNT IS THE ASSERTION THAT MATTERS, and it is checked first. The
    // return values are what this app believes happened; the row count is what
    // the queue actually did, and only the second one costs money.
    const jobCount = await countJobs(singletonKey);
    assert.equal(
      jobCount,
      1,
      `${BURST_SIZE} concurrent enqueues left ${jobCount} job(s) on queue '${QUEUE}' for one singleton key. ` +
        "Exactly one is the invariant: the queue's 'stately' policy makes the singleton key unique per state, so " +
        'a duplicate cannot be created. Each extra job is a workflow run that can read an empty cache and pay a ' +
        'provider. See the first case in this file for the mechanism.',
    );

    const queued = outcomes.filter((outcome) => outcome === 'queued');
    const deduped = outcomes.filter((outcome) => outcome === 'deduped');
    assert.equal(queued.length, 1, `expected exactly one 'queued', got ${queued.length}`);
    assert.equal(deduped.length, BURST_SIZE - 1, `expected ${BURST_SIZE - 1} 'deduped', got ${deduped.length}`);
  });

  it('still queues the same headword under a later prompt version', { skip: !DB_HOST ? 'DB_HOST not set' : false }, async () => {
    // THIS CASE ONLY DISCRIMINATES WHEN THE ONE ABOVE IS GREEN. If nothing
    // dedupes, everything queues and this passes while proving nothing. It is
    // here to catch the opposite mistake, a key so coarse that a re-worded
    // prompt can never be re-enriched, and it is worth exactly that much.
    const outcome = await enqueueEnrichment(nextVersionPayload);

    assert.equal(outcome, 'queued', 'a new prompt version was deduped against the old one');
    assert.equal(await countJobs(enrichmentSingletonKey(nextVersionPayload)), 1);
  });
});
