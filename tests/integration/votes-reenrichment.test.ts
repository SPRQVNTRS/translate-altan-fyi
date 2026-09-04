/**
 * What a down-vote is allowed to buy, driven through the real vote route.
 *
 * WHAT THIS FILE HOLDS IN PLACE
 *   `POST /api/enrichment-vote` is the one path where a reader's click can order
 *   a paid model call. Four guards stand in front of that call and each one is a
 *   separate decision, so each is exercised separately here. A red case is a
 *   real defect, and three of the five cost money when they fail.
 *
 *   1. ONE VOTE PER READER. The composite primary key on
 *      (enrichmentId, accountId) is the whole rule, and `castVote` upserts on
 *      it. A plain insert would append a second row, the tally would count one
 *      person twice, and a single reader could push a score as far as they liked
 *      by clicking again, which is precisely what buys the model call.
 *   2. A RE-RUN MUST BE ABLE TO PRODUCE SOMETHING NEW. A low-scoring row that is
 *      already on the CURRENT model and prompt version is flagged for a human,
 *      never re-queued: the same input through the same model under the same
 *      prompt reproduces the complaint at full price.
 *   3. A STALE ROW IS RE-QUEUED, ONCE. The cooldown row is what stops a small
 *      group clicking in turn from ordering one paid run after another, so a
 *      second down-vote inside the window must queue nothing.
 *   4. AN ANONYMOUS VOTE IS REFUSED, LOUDLY. A 401 with no row written, rather
 *      than a quiet 200 that drops the vote: a reader who is silently ignored
 *      clicks again, and a vote path that accepts anonymous writes has no
 *      "one vote per reader" rule left at all.
 *
 * NO PROVIDER IS INVOLVED. The queue is exercised, the worker is deliberately
 * NOT started, so no job is ever executed and no model is ever called. The
 * assertions are the queued job row and the cooldown cursor.
 *
 * THE PRECONDITION IS A REACHABLE DATABASE
 *   `DB_HOST` and the other `DB_*` variables, nothing else. Every case gates on
 *   `DB_HOST` alone, which `tests/unit/integration-tests-self-skip.test.ts`
 *   enforces.
 *
 * ISOLATION
 *   Every dictionary row this file votes on is created by this file: its own
 *   source, headword, sense and three enrichments, all under fresh random
 *   UUIDs, and all deleted in `after()` in foreign-key-safe order. No existing
 *   dictionary row is read, written or reused, and the only shared rows touched
 *   at all are the ones this file inserted.
 *
 * THE CASES RUN IN ORDER, AND TWO OF THEM DEPEND ON IT
 *   The cooldown case asserts that the cursor written by the re-queue case does
 *   NOT move. It therefore has to run after it. The flagged case runs first, so
 *   it can assert that no cooldown row exists at all rather than that an
 *   existing one stood still, which is the stronger statement.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { RouterContextProvider } from 'react-router';

import { pool } from '../../drizzle/db';
import { getRawDb } from '../../drizzle/db';
import {
  enrichmentVotes,
  enrichments,
  headwords,
  reenrichmentLog,
  senses,
  sources,
  users,
  workflows,
} from '../../drizzle/schema';
import { action } from '../../app/routes/api.enrichment-vote';
import { isBudgetExhausted } from '../../app/lib/abuse/budget.server';
import { ENRICHMENT_QUEUE } from '../../app/lib/enrichment/limits';
import { enrichmentSingletonKey } from '../../app/lib/enrichment/job-payload';
import { castVote } from '../../app/models/votes.server';
import { getActiveModel } from '../../app/models/app-settings.server';
import { MIN_VOTES_FOR_SCORE } from '../../app/lib/votes/score';
import { PROMPT_VERSION } from '../../app/prompts/enrichment/version';
import { sessionStorage } from '../../app/services/session.server';
import { initializeWorkflows, stopOrchestrator } from '../../app/services/workflows.server';

const DB_HOST = process.env.DB_HOST;

const db = getRawDb();

/** Every row this file creates, under ids that exist nowhere else. */
const SOURCE_ID = randomUUID();
const HEADWORD_ID = randomUUID();
const SENSE_ID = randomUUID();
const STALE_ENRICHMENT_ID = randomUUID();
const CURRENT_ENRICHMENT_ID = randomUUID();
const UPSERT_ENRICHMENT_ID = randomUUID();

const ENRICHMENT_IDS = [STALE_ENRICHMENT_ID, CURRENT_ENRICHMENT_ID, UPSERT_ENRICHMENT_ID];

/** The direction the enrichments are written for. Both codes are served, so a re-run is possible. */
const FROM = 'de';
const TO = 'en';

/**
 * The two signed-in readers whose votes drive the route.
 *
 * REAL ROWS, NOT ARBITRARY IDS. `enrichment_votes.accountId` carries a foreign
 * key to `users` since M191, so a vote by a user that does not exist is refused
 * by Postgres. These are seeded in `before` and their ids are whatever `serial`
 * hands out.
 */
const VOTER_HANDLE = `zz-voter-${randomUUID()}@example.invalid`;
const SECOND_VOTER_HANDLE = `zz-voter-${randomUUID()}@example.invalid`;
let voterAccountId = 0;
let secondVoterAccountId = 0;

/** The model on the stale row. Deliberately not a real model id: nothing may resolve or call it. */
const STALE_MODEL = 'stale-model-under-test';

/** The model the current row carries, read from the settings at startup so the case follows the deployment. */
let activeModel = '';

/** How many votes must already exist before the route's own vote reaches the minimum. */
const PRESEEDED_VOTES = MIN_VOTES_FOR_SCORE - 1;

/**
 * The response body, decoded rather than trusted.
 *
 * The route answers six different shapes behind one `state` discriminant, and a
 * test that read `body.state` off an untyped value would keep passing if the
 * field were renamed.
 */
const voteResponseSchema = z.object({
  state: z.string(),
  up: z.number().optional(),
  down: z.number().optional(),
  messageKey: z.string().optional(),
});

/**
 * A `Cookie` header holding a real signed session for one user id.
 *
 * This file drives the vote route, which reads the user id and nothing else.
 */
async function signedCookieFor(accountId: number): Promise<string> {
  const session = await sessionStorage.getSession();
  session.set('user', { id: accountId, issuedAt: new Date().toISOString() });
  const setCookie = await sessionStorage.commitSession(session);
  return setCookie.split(';')[0] ?? '';
}

/** One throwaway user, so a vote has something to point its foreign key at. */
async function seedAccount(handle: string): Promise<number> {
  const [row] = await db
    .insert(users)
    .values({
      email: handle,
      // A fixed non-secret string of the right shape. This file never
      // authenticates; it only needs a row the foreign key can resolve.
      passwordHash: '$2b$10$abcdefghijklmnopqrstuvwxyz012345678901234567890123456789',
      emailVerifiedAt: new Date(),
    })
    .returning({ id: users.id });
  if (!row) throw new Error(`failed to seed the fixture user ${handle}`);
  return row.id;
}

/** Post one vote to the route, exactly as the entry page's fetcher does. */
async function postVote(params: { enrichmentId: string; value: '1' | '-1'; cookie: string | null }): Promise<Response> {
  const body = new FormData();
  body.set('enrichmentId', params.enrichmentId);
  body.set('value', params.value);

  const headers = new Headers();
  if (params.cookie !== null) headers.set('cookie', params.cookie);

  const request = new Request('https://translate.altan.fyi/api/enrichment-vote', {
    method: 'POST',
    headers,
    body,
  });

  // The full argument shape the router hands a server action: the request, the
  // normalized URL, the route's dynamic params (this route has none), the
  // un-interpolated pattern, and an empty middleware context.
  return action({
    request,
    url: new URL(request.url),
    params: {},
    pattern: '/api/enrichment-vote',
    context: new RouterContextProvider(),
  });
}

/** The decoded JSON body of a route response. */
async function readBody(response: Response): Promise<z.infer<typeof voteResponseSchema>> {
  return voteResponseSchema.parse(await response.json());
}

/** Every account this file created for a pre-seeded vote, so `after` can delete them. */
const preseededAccountIds: number[] = [];

/** Fill an enrichment's tally to one vote short of the minimum, all of them down-votes. */
async function preseedDownVotes(enrichmentId: string): Promise<void> {
  for (let index = 0; index < PRESEEDED_VOTES; index += 1) {
    // Each pre-seeded vote needs its OWN account, because the composite primary
    // key would otherwise make the second one replace the first and the tally
    // would never reach the minimum.
    const accountId = await seedAccount(`zz-preseed-${randomUUID()}`);
    preseededAccountIds.push(accountId);
    await castVote(db, { enrichmentId, accountId, value: -1 });
  }
}

/** How many votes exist for one enrichment. */
async function countVotes(enrichmentId: string): Promise<number> {
  const rows = await db
    .select({ count: sql<number>`count(*)`.mapWith(Number) })
    .from(enrichmentVotes)
    .where(eq(enrichmentVotes.enrichmentId, enrichmentId));
  return rows[0]?.count ?? 0;
}

/** The cooldown cursor for this file's headword and direction, or null. */
async function readCooldownCursor(): Promise<Date | null> {
  const rows = await db
    .select({ lastQueuedAt: reenrichmentLog.lastQueuedAt })
    .from(reenrichmentLog)
    .where(eq(reenrichmentLog.headwordId, HEADWORD_ID));
  return rows[0]?.lastQueuedAt ?? null;
}

/** Whether one enrichment is flagged for a human. */
async function readFlagged(enrichmentId: string): Promise<boolean> {
  const rows = await db
    .select({ flagged: enrichments.flaggedForReview })
    .from(enrichments)
    .where(eq(enrichments.id, enrichmentId));
  return rows[0]?.flagged ?? false;
}

/** How many pg-boss jobs carry this file's singleton key on the enrichment queue. */
async function countQueuedJobs(): Promise<number> {
  const singletonKey = enrichmentSingletonKey({
    headwordId: HEADWORD_ID,
    from: FROM,
    to: TO,
    promptVersion: PROMPT_VERSION,
  });
  const result = await db.execute(
    sql`select count(*)::int as count from pgboss.job where name = ${ENRICHMENT_QUEUE} and singleton_key = ${singletonKey}`,
  );
  const [row] = result.rows;
  return Number(row?.count ?? 0);
}

before(async () => {
  if (!DB_HOST) return;

  // The orchestrator is registered so `enqueueEnrichment` can reach `boss.send`.
  // The WORKER is deliberately not started: the point is to see a job queued,
  // not to run one, and a running worker would call a provider.
  await initializeWorkflows();

  activeModel = (await getActiveModel()).model;

  voterAccountId = await seedAccount(VOTER_HANDLE);
  secondVoterAccountId = await seedAccount(SECOND_VOTER_HANDLE);

  await db.insert(sources).values({
    id: SOURCE_ID,
    slug: `votes-reenrichment-test-${SOURCE_ID}`,
    name: 'Vote re-enrichment test fixture',
    licence: 'CC0-1.0',
    attribution: 'test fixture, deleted by this file',
  });

  await db.insert(headwords).values({
    id: HEADWORD_ID,
    languageCode: FROM,
    lemma: `zz-test-${HEADWORD_ID}`,
    lemmaNormalized: `zz-test-${HEADWORD_ID}`,
    sourceId: SOURCE_ID,
  });

  await db.insert(senses).values({ id: SENSE_ID, headwordId: HEADWORD_ID, sourceId: SOURCE_ID });

  const common = {
    senseId: SENSE_ID,
    headwordId: HEADWORD_ID,
    fromLanguageCode: FROM,
    toLanguageCode: TO,
    provider: 'test-fixture',
    status: 'ok',
    output: { notes: 'fixture' },
    latencyMs: 1,
  };

  await db.insert(enrichments).values([
    // The stale row: neither its model nor its prompt version is current, so a
    // re-run can genuinely produce something else.
    { ...common, id: STALE_ENRICHMENT_ID, model: STALE_MODEL, promptVersion: PROMPT_VERSION - 1 },
    // The current row: re-running it would buy nothing.
    { ...common, id: CURRENT_ENRICHMENT_ID, model: activeModel, promptVersion: PROMPT_VERSION },
    // A row nothing else votes on, so the upsert case cannot disturb a tally.
    { ...common, id: UPSERT_ENRICHMENT_ID, model: `${STALE_MODEL}-upsert`, promptVersion: PROMPT_VERSION - 1 },
  ]);
});

after(async () => {
  if (!DB_HOST) {
    await pool.end();
    return;
  }

  await stopOrchestrator();

  // Foreign-key-safe order, innermost first. Every predicate names a row this
  // file created and nothing else.
  for (const enrichmentId of ENRICHMENT_IDS) {
    await db.delete(enrichmentVotes).where(eq(enrichmentVotes.enrichmentId, enrichmentId));
  }
  await db.delete(reenrichmentLog).where(eq(reenrichmentLog.headwordId, HEADWORD_ID));
  await db.delete(enrichments).where(eq(enrichments.headwordId, HEADWORD_ID));
  await db.delete(senses).where(eq(senses.id, SENSE_ID));
  await db.delete(headwords).where(eq(headwords.id, HEADWORD_ID));
  await db.delete(sources).where(eq(sources.id, SOURCE_ID));
  // Last, and after the votes: the vote foreign key cascades, but deleting the
  // accounts first would silently take rows this file wanted to assert on.
  for (const accountId of [voterAccountId, secondVoterAccountId, ...preseededAccountIds]) {
    if (accountId !== 0) await db.delete(users).where(eq(users.id, accountId));
  }

  await db.delete(workflows).where(sql`${workflows.context}->>'headwordId' = ${HEADWORD_ID}`);
  await db.execute(
    sql`delete from pgboss.job where name = ${ENRICHMENT_QUEUE} and singleton_key like ${`${HEADWORD_ID}:%`}`,
  );

  await pool.end();
});

describe('votes: casting one', () => {
  it('replaces the earlier vote of one reader instead of adding a second row', { skip: !DB_HOST ? 'DB_HOST not set' : false }, async () => {
    const cookie = await signedCookieFor(voterAccountId);

    const first = await postVote({ enrichmentId: UPSERT_ENRICHMENT_ID, value: '-1', cookie });
    assert.equal(first.status, 200);

    const [firstRow] = await db
      .select({ value: enrichmentVotes.value, updatedAt: enrichmentVotes.updatedAt })
      .from(enrichmentVotes)
      .where(eq(enrichmentVotes.enrichmentId, UPSERT_ENRICHMENT_ID));
    assert.ok(firstRow !== undefined, 'the first vote wrote no row');
    assert.equal(firstRow.value, -1);

    // A gap the clock can resolve, so "the timestamp moved" is a real
    // observation rather than a coin toss on millisecond boundaries.
    await new Promise((resolve) => setTimeout(resolve, 5));

    const second = await postVote({ enrichmentId: UPSERT_ENRICHMENT_ID, value: '1', cookie });
    const body = await readBody(second);

    assert.equal(
      await countVotes(UPSERT_ENRICHMENT_ID),
      1,
      'the second vote added a row instead of replacing the first, so one reader is counted twice and can push ' +
        'a score as far as they like by clicking again',
    );
    assert.equal(body.up, 1, 'the tally did not follow the changed vote');
    assert.equal(body.down, 0);

    const [secondRow] = await db
      .select({ value: enrichmentVotes.value, updatedAt: enrichmentVotes.updatedAt })
      .from(enrichmentVotes)
      .where(eq(enrichmentVotes.enrichmentId, UPSERT_ENRICHMENT_ID));
    assert.ok(secondRow !== undefined);
    assert.equal(secondRow.value, 1, 'the second vote did not win, so a reader cannot change their mind');
    assert.ok(
      secondRow.updatedAt.getTime() > firstRow.updatedAt.getTime(),
      'updatedAt is frozen at the first vote. The $onUpdate hook in Drizzle does not fire inside a conflict ' +
        'clause, so the column has to be set explicitly there, and a stale timestamp misreports when a tally ' +
        'last changed.',
    );

    // The account id on the row is the signed-in reader's own, and it is the
    // ONLY thing on the row besides the enrichment: no headword, no query.
    const [ownerRow] = await db
      .select({ accountId: enrichmentVotes.accountId })
      .from(enrichmentVotes)
      .where(eq(enrichmentVotes.enrichmentId, UPSERT_ENRICHMENT_ID));
    assert.equal(ownerRow?.accountId, voterAccountId);
  });

  it('refuses an anonymous vote with 401 and writes nothing', { skip: !DB_HOST ? 'DB_HOST not set' : false }, async () => {
    const votesBefore = await countVotes(CURRENT_ENRICHMENT_ID);

    const response = await postVote({ enrichmentId: CURRENT_ENRICHMENT_ID, value: '-1', cookie: null });
    const body = await readBody(response);

    assert.equal(
      response.status,
      401,
      `an anonymous vote answered ${response.status}. A silent 200 would drop the vote while telling the reader ` +
        'it counted, and the reader then clicks again.',
    );
    assert.equal(body.state, 'unauthenticated');
    assert.equal(
      await countVotes(CURRENT_ENRICHMENT_ID),
      votesBefore,
      'an anonymous vote wrote a row, so votes exist that belong to nobody and the one-vote-per-reader key ' +
        'means nothing',
    );
  });
});

describe('votes: what a low score buys', () => {
  it('flags a row that is already on the current model and prompt version, and queues nothing', { skip: !DB_HOST ? 'DB_HOST not set' : false }, async () => {
    assert.equal(
      await readCooldownCursor(),
      null,
      'this headword already has a cooldown row before any case wrote one, so the assertions below cannot ' +
        'distinguish a queued re-enrichment from a stale fixture',
    );

    await preseedDownVotes(CURRENT_ENRICHMENT_ID);
    const cookie = await signedCookieFor(voterAccountId);

    const body = await readBody(await postVote({ enrichmentId: CURRENT_ENRICHMENT_ID, value: '-1', cookie }));

    assert.equal(body.down, MIN_VOTES_FOR_SCORE, 'the tally did not reach the minimum, so no verdict was possible');
    assert.equal(
      body.state,
      'flagged',
      `a low-scoring row on the CURRENT model and prompt version answered '${body.state}'. Re-running identical ` +
        'input through an identical model under an identical prompt reproduces the complaint at full price, so ' +
        'the only other thing to do is flag it for a human.',
    );
    assert.equal(await readFlagged(CURRENT_ENRICHMENT_ID), true, 'nothing was flagged, so the review queue is empty');
    assert.equal(await readCooldownCursor(), null, 'a flagged row started a cooldown it never used');
    assert.equal(await countQueuedJobs(), 0, 'a row that cannot be improved was queued for a paid re-run anyway');
  });

  it('queues a re-enrichment for a stale row and records the cooldown', { skip: !DB_HOST ? 'DB_HOST not set' : false }, async () => {
    // The premise. The route asks the real budget before queueing, so a day
    // that is already spent would turn this case into a refusal and the failure
    // would read as a broken queue.
    assert.equal(
      await isBudgetExhausted(),
      false,
      "today's budget is already exhausted in this database, so the route refuses every re-enrichment and this " +
        'case cannot observe the queue',
    );

    await preseedDownVotes(STALE_ENRICHMENT_ID);
    const cookie = await signedCookieFor(voterAccountId);

    const body = await readBody(await postVote({ enrichmentId: STALE_ENRICHMENT_ID, value: '-1', cookie }));

    assert.equal(
      body.state,
      'improving',
      `a low-scoring row on model '${STALE_MODEL}' at prompt version ${PROMPT_VERSION - 1} answered ` +
        `'${body.state}'. The current version is ${PROMPT_VERSION}, so a re-run can genuinely produce ` +
        'something the reader has not already rejected.',
    );

    assert.equal(
      await countQueuedJobs(),
      1,
      'no job reached the enrichment queue, so the reader is told the notes are being improved while nothing ' +
        'is running',
    );

    const cursor = await readCooldownCursor();
    assert.ok(
      cursor !== null,
      'no cooldown row was written, so the next down-vote queues another paid run and a small group clicking in ' +
        'turn can order one after another',
    );
    assert.equal(await readFlagged(STALE_ENRICHMENT_ID), false, 'a re-queued row was also flagged for a human');
  });

  it('queues nothing for a second down-vote inside the cooldown window', { skip: !DB_HOST ? 'DB_HOST not set' : false }, async () => {
    const cursorBefore = await readCooldownCursor();
    assert.ok(cursorBefore !== null, 'the case above did not leave a cursor, so this one cannot test the window');

    // A DIFFERENT reader, so the vote is a new row rather than an upsert, and
    // the tally genuinely grows. The score stays low, so every guard except the
    // cooldown says yes.
    const cookie = await signedCookieFor(secondVoterAccountId);
    const body = await readBody(await postVote({ enrichmentId: STALE_ENRICHMENT_ID, value: '-1', cookie }));

    assert.equal(body.down, MIN_VOTES_FOR_SCORE + 1, 'the vote of the second reader was not counted');
    assert.equal(
      body.state,
      'recorded',
      `a down-vote inside the cooldown answered '${body.state}'. The window is the spend guard against a ` +
        'small group clicking in turn: without it, five readers can order five paid runs of one headword in ' +
        'five minutes.',
    );

    const cursorAfter = await readCooldownCursor();
    assert.equal(
      cursorAfter?.getTime(),
      cursorBefore.getTime(),
      'the cooldown cursor moved on a refused request, so every further vote pushes the window out and the pair ' +
        'is locked out of a run it never got',
    );
    assert.equal(await countQueuedJobs(), 1, 'a second job was queued inside the cooldown window');
  });
});
