/**
 * Two enqueues of one key must produce ONE job and ONE pending run.
 *
 * WHAT THIS FILE HOLDS IN PLACE
 *   Translation runs on its OWN pg-boss queue, `translation`, carrying the
 *   `stately` policy. Both halves of that sentence are load-bearing, and a red
 *   case here is a real defect that costs money and writes duplicate dictionary
 *   rows.
 *
 *   1. In pg-boss 10.4.2 the unique indexes that make `singleton_key` mean
 *      anything are ALL policy-gated (src/plans.js: `job_i1` needs policy
 *      `short`, `job_i2` needs `singleton`, `job_i3` needs `stately`). Under the
 *      default `standard` policy no index covers the column, so the key is
 *      stored and enforces nothing.
 *   2. `insertJob` ends in `ON CONFLICT DO NOTHING`, so with no constraint to
 *      conflict on there is nothing to swallow. Every send returns an id and the
 *      `deduped` branch can never fire.
 *   3. `@sprqvntrs/workflows` 0.2.5 creates every queue with
 *      `boss.createQueue(name)` and no options, so the library cannot set a
 *      policy, and `create_queue` is itself ON CONFLICT DO NOTHING, so a restart
 *      cannot repair one. Only the explicit createQueue/updateQueue pair in
 *      `initializeWorkflows` can.
 *
 *   `stately` rather than `short`: `short` only dedupes jobs still in `created`,
 *   so a second enqueue arriving after the first goes active queues a second job
 *   and both pay.
 *
 *   THE RUN ROW IS THE SECOND HALF, and it is specific to this feature. The
 *   enqueue opens a `pending` run BEFORE it queues, so a deduped request has
 *   already written one. That row must not survive: the pane reads the LATEST
 *   run for a key, so a leftover row would be newer than the running job's and
 *   the reader would be shown the wrong state.
 *
 *   This file must not be made green by weakening an assertion.
 *
 * NO PROVIDER IS INVOLVED HERE AT ALL. No worker is started, so nothing runs;
 * the point is to count what was queued.
 *
 * THE PRECONDITION IS A REACHABLE DATABASE. Every case gates on `DB_HOST`.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { eq, sql } from 'drizzle-orm';

import { getRawDb, pool } from '../../drizzle/db';
import { translationRuns, workflows } from '../../drizzle/schema';
import { enqueueTranslation, translationSingletonKey } from '../../app/lib/translation/enqueue.server';
import { TRANSLATION_QUEUE } from '../../app/lib/translation/limits';
import { PROMPT_VERSION } from '../../app/prompts/translation/version';
import { initializeWorkflows, stopOrchestrator } from '../../app/services/workflows.server';
import { translateHeadwordTemplate } from '../../app/workflows/templates/translate-headword';
import { createFakeLlmPort } from '../fixtures/fake-llm-port';
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

/** How many enqueues race. */
const BURST_SIZE = 10;

/**
 * The policy the translation queue must carry.
 *
 * `short` and `singleton` also cover `singleton_key` with an index, but only
 * `stately` bars a SECOND ACTIVE run for one key, and that is the guarantee that
 * protects both the money and the dictionary.
 */
const REQUIRED_POLICY = 'stately';

let fixture: TranslationFixture = {
  sourceId: '',
  generatedSourceId: '',
  fake: createFakeLlmPort(),
  run: '',
  seededHeadwordIds: [],
};

/** A real headword, because `translation_runs.headword_id` is a foreign key. */
let headwordId = '';

async function countJobs(singletonKey: string): Promise<number> {
  const result = await db.execute(
    sql`select count(*)::int as count from pgboss.job where name = ${TRANSLATION_QUEUE} and singleton_key = ${singletonKey}`,
  );
  const [row] = result.rows;
  return Number(row?.count ?? 0);
}

async function readQueuePolicy(): Promise<string | null> {
  const result = await db.execute(sql`select policy from pgboss.queue where name = ${TRANSLATION_QUEUE}`);
  const [row] = result.rows;
  return row?.policy === undefined || row.policy === null ? null : String(row.policy);
}

/** Every run row that exists for the seeded headword, whatever its status. */
async function runsForHeadword() {
  return db
    .select({ id: translationRuns.id, status: translationRuns.status })
    .from(translationRuns)
    .where(eq(translationRuns.headwordId, headwordId));
}

before(async () => {
  if (!DB_HOST) return;
  fixture = await setUpTranslationFixture('dedupe');
  headwordId = await seedHeadword(fixture, {
    lemma: `zzdedupe${fixture.run}`,
    languageCode: FROM,
    pos: 'verb',
  });
  // The honest path: this registers the templates, so `start()` can resolve
  // `translate-headword` and reach `boss.send`. The WORKER is deliberately not
  // started; a running worker would drain the queue underneath the assertions.
  await initializeWorkflows();
});

after(async () => {
  if (!DB_HOST) {
    await pool.end();
    return;
  }
  await stopOrchestrator();
  await db.delete(workflows).where(sql`${workflows.context}->>'headwordId' = ${headwordId}`);
  await db.execute(
    sql`delete from pgboss.job where name = ${TRANSLATION_QUEUE} and singleton_key like ${`${headwordId}:%`}`,
  );
  await tearDownTranslationFixture(fixture, []);
  await pool.end();
});

describe('translation enqueue dedupe', () => {
  it(
    'runs translation on a queue whose policy makes a singleton key bite',
    {
      skip: !DB_HOST ? 'DB_HOST not set' : false,
    },
    async () => {
      // This case runs first ON PURPOSE. It is the root cause of the next one, and
      // reading a red burst as "the burst is racy" would send the reader hunting
      // for a race that is not there.
      assert.equal(
        translateHeadwordTemplate.queue,
        TRANSLATION_QUEUE,
        `the translate-headword template sends to '${translateHeadwordTemplate.queue}', not the dedicated ` +
          `'${TRANSLATION_QUEUE}' queue, so the policy asserted below does not govern its jobs`,
      );

      const policy = await readQueuePolicy();
      assert.ok(policy !== null, `the pg-boss queue '${TRANSLATION_QUEUE}' does not exist, so nothing was enqueued`);
      assert.equal(
        policy,
        REQUIRED_POLICY,
        `The pg-boss queue '${TRANSLATION_QUEUE}' has policy '${policy}', not '${REQUIRED_POLICY}'. In pg-boss 10.4.2 ` +
          'every unique index over singleton_key is policy-gated, and only stately is unique per (queue, state, key) ' +
          'for every state up to active. The policy can only come from the explicit createQueue plus updateQueue pair ' +
          'in initializeWorkflows. If this is red, that wiring is gone or the queue predates it.',
      );
    },
  );

  it(
    'turns a concurrent burst into exactly one job and exactly one pending run',
    {
      skip: !DB_HOST ? 'DB_HOST not set' : false,
    },
    async () => {
      const request = { headwordId, from: FROM, to: TO, promptVersion: PROMPT_VERSION } as const;
      const singletonKey = translationSingletonKey({ ...request, runId: 'not-part-of-the-key' });

      const results = await Promise.all(Array.from({ length: BURST_SIZE }, () => enqueueTranslation(db, request)));

      // THE JOB COUNT IS THE ASSERTION THAT MATTERS, and it is checked first. The
      // return values are what this app believes happened; the row count is what
      // the queue actually did, and only the second one costs money.
      const jobCount = await countJobs(singletonKey);
      assert.equal(
        jobCount,
        1,
        `${BURST_SIZE} concurrent enqueues left ${jobCount} job(s) on queue '${TRANSLATION_QUEUE}' for one key. ` +
          'Each extra job is a paid model call and a second set of generated rows for the same word.',
      );

      const queued = results.filter((result) => result.outcome === 'queued');
      const deduped = results.filter((result) => result.outcome === 'deduped');
      assert.equal(queued.length, 1, `expected exactly one 'queued', got ${queued.length}`);
      assert.equal(deduped.length, BURST_SIZE - 1, `expected ${BURST_SIZE - 1} 'deduped', got ${deduped.length}`);

      // THE ORPHAN ROWS ARE THE OTHER HALF. Each deduped call had already opened a
      // `pending` run before it discovered it was a duplicate. Every one of those
      // but the winner's must be gone, because the pane reads the LATEST run for a
      // key: a leftover would be newer than the running job's row, so the reader
      // would be told the state of a run nobody is working on.
      const runs = await runsForHeadword();
      assert.equal(
        runs.length,
        1,
        `${runs.length} run rows exist for one key after a deduped burst. Every deduped enqueue must remove the ` +
          'pending row it opened, or the pane reads a run no job will ever finish.',
      );
      assert.equal(runs[0]?.id, queued[0]?.runId, 'the surviving run is not the one whose job was queued');
      assert.equal(runs[0]?.status, 'pending');
    },
  );

  it(
    'still queues the same headword under a later prompt version',
    {
      skip: !DB_HOST ? 'DB_HOST not set' : false,
    },
    async () => {
      // THIS CASE ONLY DISCRIMINATES WHEN THE ONE ABOVE IS GREEN. If nothing
      // dedupes, everything queues and this passes while proving nothing. It is
      // here to catch the opposite mistake, a key so coarse that a re-worded
      // prompt can never be asked again.
      const request = { headwordId, from: FROM, to: TO, promptVersion: PROMPT_VERSION + 1 } as const;
      const result = await enqueueTranslation(db, request);

      assert.equal(result.outcome, 'queued', 'a new prompt version was deduped against the old one');
      assert.equal(await countJobs(translationSingletonKey({ ...request, runId: 'ignored' })), 1);
    },
  );
});
