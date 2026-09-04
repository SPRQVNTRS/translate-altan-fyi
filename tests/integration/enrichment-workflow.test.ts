/**
 * The enrichment job, driven end to end against a real Postgres, with the
 * provider faked.
 *
 * WHY A DB-BACKED TEST AT ALL
 *   Everything this job is worth is in the rows it leaves behind. That a cached
 *   sense costs no second call, that a failed call still records one row per
 *   pending sense, that two senses of one headword cache independently: all
 *   three are claims about the contents of `enrichments` under a partial unique
 *   index, and only the database can answer them. A unit test could assert the
 *   summary object and be green while the cache never worked.
 *
 * THE PRECONDITION IS A REACHABLE DATABASE
 *   `DB_HOST` and the other `DB_*` variables, and nothing else: no API key, and
 *   no server on :3456. Every case gates on `DB_HOST` alone. The pre-push gate
 *   starts no database, so every case skips there; see
 *   `tests/unit/integration-tests-self-skip.test.ts`.
 *
 * NO LIVE API IS REACHABLE FROM THIS FILE
 *   `registry.withProvider` installs a fake port in `before()` and restores the
 *   real one in `after()`. The provider keys set below are dummies that exist
 *   only so `configureActiveModel` finds the environment variable it demands.
 *   Their VALUES are never used, because no real client is ever built.
 *
 * THE APP'S OWN HANDLE, NOT A SECOND POOL
 *   `runEnrichHeadword` reads through `getRawDb()`, so this file sets up and
 *   asserts through the same handle. A second pool of its own would be a second
 *   reading of the `DB_*` variables, and an assertion made against a different
 *   database than the one the code wrote to is the kind of green that means
 *   nothing. The pool is closed in `after()`.
 *
 * ISOLATION
 *   Every row this file creates carries a run-scoped random suffix, and every
 *   row is deleted again in `after()`, in foreign-key-safe order. Nothing
 *   pre-existing is read, written, or deleted, and the seeded `languages` rows
 *   are only ever referenced.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';

import { enrichments, headwords, senseVersions, senses, sources } from '../../drizzle/schema';
import { getRawDb } from '../../drizzle/db';
import { pool } from '../../drizzle/db';
import type { JsonValue } from '../../app/lib/json';
import type { EnrichmentJobPayload } from '../../app/lib/enrichment/job-payload';
import { registry, type ActiveModel } from '../../app/lib/llm/registry.server';
import { getActiveModel } from '../../app/models/app-settings.server';
import { listEnrichedSenseIds } from '../../app/models/enrichments.server';
import { PROMPT_VERSION } from '../../app/prompts/enrichment/version';
import { runEnrichHeadword } from '../../app/workflows/operations/enrichment/enrich-headword';
import { createFakeLlmPort, llmError, llmValue, type FakeLlmPort } from '../fixtures/fake-llm-port';

const DB_HOST = process.env.DB_HOST;

const db = getRawDb();

/** Every row this run creates carries this suffix, so cleanup can be exact. */
const RUN = randomUUID().slice(0, 8);
/** The direction under test. Both codes are languages the migration seeds. */
const FROM = 'de';
const TO = 'en';

/** The provider keys, set to a dummy so the registry's configuration check passes. */
const KEY_VARS = ['OPENROUTER_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY'] as const;
const DUMMY_KEY = 'stub-key-not-a-real-credential';
const savedKeys = new Map<string, string | undefined>();

/** What one seeded headword looks like to the cases below. */
interface SeededHeadword {
  headwordId: string;
  senseIds: string[];
}

let sourceId = '';
let active: ActiveModel = { provider: 'gemini', model: '', options: {} };
let fake: FakeLlmPort = createFakeLlmPort();

const seeded: SeededHeadword[] = [];
/** Every headword this run created, so `after()` deletes exactly those rows. */
const createdHeadwordIds: string[] = [];

function payloadFor(headwordId: string): EnrichmentJobPayload {
  return { headwordId, from: FROM, to: TO, promptVersion: PROMPT_VERSION };
}

/** One well-formed model answer for one sense. It must satisfy `enrichmentOutputSchema`. */
function answerFor(senseId: string): JsonValue {
  return {
    senseId,
    translation: ['snail'],
    explanation: 'A small animal that carries its shell.',
    register: 'neutral',
    usageNotes: 'Everyday word, no restriction on register.',
    examples: [
      { text: 'Die Schnecke kriecht.', translation: 'The snail crawls.' },
      { text: 'Eine kleine Schnecke.', translation: 'A small snail.' },
      { text: 'Schnecken im Garten.', translation: 'Snails in the garden.' },
    ],
    commonMistakes: ['Do not confuse it with the pastry sense.'],
  };
}

/** A whole answer covering the given senses, as the fake returns it. */
function answerCovering(senseIds: string[]): JsonValue {
  return { senses: senseIds.map(answerFor) };
}

/** Create one headword with `senseCount` senses, each with one English gloss. */
async function seedHeadword(slug: string, senseCount: number): Promise<SeededHeadword> {
  const lemma = `zzenrich${slug}${RUN}`;
  const [headword] = await db
    .insert(headwords)
    .values({ languageCode: FROM, lemma, lemmaNormalized: lemma, pos: 'noun', sourceId })
    .returning({ id: headwords.id });
  assert.ok(headword, 'failed to create the test headword');
  createdHeadwordIds.push(headword.id);

  const senseIds: string[] = [];
  for (let index = 0; index < senseCount; index += 1) {
    const [sense] = await db
      .insert(senses)
      .values({ headwordId: headword.id, sourceId, externalId: `${lemma}-s${index}` })
      .returning({ id: senses.id });
    assert.ok(sense, 'failed to create the test sense');
    senseIds.push(sense.id);
    await db.insert(senseVersions).values({
      senseId: sense.id,
      version: 1,
      glossLanguageCode: TO,
      gloss: `test gloss ${index} for ${lemma}`,
      sourceId,
    });
  }

  const record = { headwordId: headword.id, senseIds };
  seeded.push(record);
  return record;
}

/** Every enrichment row for one headword, oldest first, so assertions can be exact. */
async function rowsFor(headwordId: string) {
  return db
    .select({
      senseId: enrichments.senseId,
      status: enrichments.status,
      provider: enrichments.provider,
      model: enrichments.model,
      promptVersion: enrichments.promptVersion,
      costUsd: enrichments.costUsd,
      latencyMs: enrichments.latencyMs,
      error: enrichments.error,
    })
    .from(enrichments)
    .where(eq(enrichments.headwordId, headwordId));
}

let happy: SeededHeadword = { headwordId: '', senseIds: [] };
let retried: SeededHeadword = { headwordId: '', senseIds: [] };
let partial: SeededHeadword = { headwordId: '', senseIds: [] };
let omitted: SeededHeadword = { headwordId: '', senseIds: [] };

before(async () => {
  if (!DB_HOST) return;

  for (const name of KEY_VARS) {
    savedKeys.set(name, process.env[name]);
    process.env[name] = DUMMY_KEY;
  }

  fake = createFakeLlmPort();
  registry.withProvider(fake);
  active = await getActiveModel();

  const [source] = await db
    .insert(sources)
    .values({
      slug: `test-enrichment-${RUN}`,
      name: `test source ${RUN}`,
      licence: 'CC0-1.0',
      attribution: `test run ${RUN}`,
    })
    .returning({ id: sources.id });
  assert.ok(source, 'failed to create the test source');
  sourceId = source.id;

  happy = await seedHeadword('happy', 2);
  retried = await seedHeadword('retry', 2);
  partial = await seedHeadword('partial', 2);
  omitted = await seedHeadword('omit', 2);
});

after(async () => {
  if (!DB_HOST) {
    await pool.end();
    return;
  }

  registry.withProvider(null);
  for (const [name, value] of savedKeys) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }

  // Foreign-key-safe order: the enrichments point at senses and headwords, the
  // versions point at senses, the senses point at headwords, and everything
  // points at the source.
  if (createdHeadwordIds.length > 0) {
    await db.delete(enrichments).where(inArray(enrichments.headwordId, createdHeadwordIds));
  }
  if (sourceId !== '') {
    await db.delete(senseVersions).where(eq(senseVersions.sourceId, sourceId));
    await db.delete(senses).where(eq(senses.sourceId, sourceId));
    await db.delete(headwords).where(eq(headwords.sourceId, sourceId));
    await db.delete(sources).where(eq(sources.id, sourceId));
  }

  await pool.end();
});

describe('enrichment workflow', () => {
  it('writes one ok row per sense from a single provider call', { skip: !DB_HOST ? 'DB_HOST not set' : false }, async () => {
    fake.reset([llmValue(answerCovering(happy.senseIds), 0.001234)]);

    const summary = await runEnrichHeadword(payloadFor(happy.headwordId));

    assert.equal(summary.outcome, 'written');
    assert.equal(summary.providerCalls, 1, 'the happy path must cost exactly one call');
    assert.equal(fake.callCount, 1);
    assert.deepEqual(summary.writtenSenseIds.toSorted(), happy.senseIds.toSorted());
    assert.deepEqual(summary.failedSenseIds, []);

    const rows = await rowsFor(happy.headwordId);
    assert.equal(rows.length, 2, `expected two rows, got ${rows.length}`);
    for (const row of rows) {
      assert.equal(row.status, 'ok');
      assert.equal(row.provider, active.provider);
      assert.equal(row.model, active.model, 'the row must name the model that actually ran');
      assert.equal(row.promptVersion, PROMPT_VERSION);
      assert.equal(row.costUsd, '0.001234', 'the cost the provider reported was not stored');
      assert.ok(row.latencyMs >= 0, 'no latency was recorded');
    }
  });

  it('calls no provider when every sense is already cached', { skip: !DB_HOST ? 'DB_HOST not set' : false }, async () => {
    fake.reset([]);

    const summary = await runEnrichHeadword(payloadFor(happy.headwordId));

    assert.equal(summary.outcome, 'cached');
    assert.equal(summary.providerCalls, 0);
    assert.equal(fake.callCount, 0, 'a cached headword reached the provider');
    const rows = await rowsFor(happy.headwordId);
    assert.equal(rows.length, 2, 'the cached run wrote extra rows');
  });

  it('retries once, then records one failed row per pending sense', { skip: !DB_HOST ? 'DB_HOST not set' : false }, async () => {
    fake.reset([llmError('first attempt refused'), llmError('second attempt refused')]);

    const summary = await runEnrichHeadword(payloadFor(retried.headwordId));

    assert.equal(summary.outcome, 'failed');
    assert.equal(summary.providerCalls, 2, 'the job must give up after exactly two attempts');
    assert.equal(fake.callCount, 2);
    assert.deepEqual(summary.failedSenseIds.toSorted(), retried.senseIds.toSorted());

    const rows = await rowsFor(retried.headwordId);
    assert.equal(rows.length, 2);
    assert.ok(
      rows.every((row) => row.status === 'failed'),
      'an ok row was written for a call that never succeeded',
    );
    assert.ok(
      rows.every((row) => (row.error ?? '').includes('second attempt refused')),
      'the failed rows do not carry the last rejection',
    );
  });

  it('caches the senses it got, and asks again only for the ones it did not', { skip: !DB_HOST ? 'DB_HOST not set' : false }, async () => {
    const [first, second] = partial.senseIds;
    assert.ok(first && second);

    fake.reset([llmValue(answerCovering([first]))]);
    const firstRun = await runEnrichHeadword(payloadFor(partial.headwordId));
    assert.deepEqual(firstRun.writtenSenseIds, [first]);

    const cached = await listEnrichedSenseIds(db, {
      headwordId: partial.headwordId,
      from: FROM,
      to: TO,
      model: active.model,
      promptVersion: PROMPT_VERSION,
    });
    assert.deepEqual(cached, [first], 'the failed sense was counted as cached');

    fake.reset([llmValue(answerCovering([second]))]);
    const secondRun = await runEnrichHeadword(payloadFor(partial.headwordId));

    assert.equal(secondRun.providerCalls, 1, 'the still-pending sense was never asked for');
    assert.deepEqual(secondRun.writtenSenseIds, [second]);
    const [call] = fake.calls;
    assert.ok(call, 'the second run made no call');
    assert.ok(call.prompt.includes(second), 'the second prompt does not name the pending sense');
    assert.ok(
      !call.prompt.includes(first),
      'the second prompt re-asked for a sense that was already cached',
    );
  });

  it('records a failed row for a sense the model simply omitted', { skip: !DB_HOST ? 'DB_HOST not set' : false }, async () => {
    const [kept, dropped] = omitted.senseIds;
    assert.ok(kept && dropped);

    fake.reset([llmValue(answerCovering([kept]))]);
    const summary = await runEnrichHeadword(payloadFor(omitted.headwordId));

    assert.deepEqual(summary.writtenSenseIds, [kept]);
    assert.deepEqual(summary.failedSenseIds, [dropped]);

    const [droppedRow] = await db
      .select({ status: enrichments.status, error: enrichments.error })
      .from(enrichments)
      .where(and(eq(enrichments.senseId, dropped), eq(enrichments.status, 'failed')));
    assert.ok(droppedRow, 'the omitted sense was left pending, so the page would wait forever');
    assert.match(droppedRow.error ?? '', /no notes/i);
  });
});
