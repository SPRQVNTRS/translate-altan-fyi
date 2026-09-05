/**
 * A malformed model answer must leave the dictionary exactly as it was.
 *
 * WHAT THIS FILE HOLDS IN PLACE
 *   The parse is the only thing standing between a model's answer and permanent
 *   rows in the shared dictionary. There is no review step and no expiry, so an
 *   answer that gets half written is an entry nobody can tell from a good one.
 *   Two properties together are what make that safe, and neither is enough
 *   alone:
 *
 *   The schema REFUSES the answer, which is what the unit tier proves. And the
 *   refusal reaches the reader as a terminal `failed` run with no dictionary row
 *   behind it, which only a database can prove: the write is one transaction, so
 *   "no row" is a claim about what a rollback did.
 *
 *   The failure is deliberately a plausible one. `pos: 'transitive verb'` is
 *   what a model actually returns when it is being helpful, and it is outside
 *   the five values that form part of the headword natural key. Accepting it
 *   would create a headword that no importer and no search can ever reach.
 *
 * THE PRECONDITION IS A REACHABLE DATABASE. Every case gates on `DB_HOST`.
 *
 * NO LIVE API IS REACHABLE FROM THIS FILE.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { count, eq } from 'drizzle-orm';

import { getRawDb, pool } from '../../drizzle/db';
import { headwords, senseVersions, senses, translations } from '../../drizzle/schema';
import { PROMPT_VERSION } from '../../app/prompts/translation/version';
import { runTranslateHeadword } from '../../app/workflows/operations/translation/translate-headword';
import { createPendingRun, getRun } from '../../app/models/translation-runs.server';
import { getActiveModel } from '../../app/models/app-settings.server';
import { createFakeLlmPort, llmValue } from '../fixtures/fake-llm-port';
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

const runIds: string[] = [];
let headwordId = '';

/** Every row in the four corpus tables. A global count, so a stray write anywhere shows up. */
async function corpusTotals(): Promise<Record<string, number>> {
  const [headwordCount] = await db.select({ total: count() }).from(headwords);
  const [senseCount] = await db.select({ total: count() }).from(senses);
  const [versionCount] = await db.select({ total: count() }).from(senseVersions);
  const [edgeCount] = await db.select({ total: count() }).from(translations);
  return {
    headwords: headwordCount?.total ?? 0,
    senses: senseCount?.total ?? 0,
    senseVersions: versionCount?.total ?? 0,
    translations: edgeCount?.total ?? 0,
  };
}

async function openRun(): Promise<string> {
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
  return runId;
}

before(async () => {
  if (!DB_HOST) return;
  fixture = await setUpTranslationFixture('invalid');
  headwordId = await seedHeadword(fixture, {
    lemma: `zzungueltig${fixture.run}`,
    languageCode: FROM,
    pos: 'verb',
  });
});

after(async () => {
  if (!DB_HOST) {
    await pool.end();
    return;
  }
  await tearDownTranslationFixture(fixture, runIds);
  await pool.end();
});

describe('a model answer that does not parse', () => {
  it(
    'ends the run failed and writes no dictionary row at all',
    {
      skip: !DB_HOST ? 'DB_HOST not set' : false,
    },
    async () => {
      const totalsBefore = await corpusTotals();

      fixture.fake.reset([
        llmValue({
          senses: [
            {
              localId: 's1',
              pos: 'verb',
              gloss: 'etwas tun',
              // The one thing wrong with this answer. Everything else about it is
              // exactly what a good answer looks like, so a run that wrote rows
              // here would write MOST of a correct entry, which is the hardest
              // kind of bad row to find later.
              translations: [{ lemma: `zzgecersiz${fixture.run}`, pos: 'transitive verb', confidence: 'high' }],
            },
          ],
        }),
      ]);

      const runId = await openRun();
      const summary = await runTranslateHeadword({
        headwordId,
        from: FROM,
        to: TO,
        promptVersion: PROMPT_VERSION,
        runId,
      });

      assert.equal(summary.outcome, 'failed', 'a part of speech outside the import enum was accepted');

      const totalsAfter = await corpusTotals();
      assert.deepEqual(
        totalsAfter,
        totalsBefore,
        'a refused answer changed the dictionary. The write is one transaction precisely so that a ' +
          'validation failure leaves nothing behind; a difference here means the transaction is not ' +
          'covering the whole write.',
      );

      const sourceSenses = await db.select({ id: senses.id }).from(senses).where(eq(senses.headwordId, headwordId));
      assert.equal(sourceSenses.length, 0, 'the headword gained a sense from an answer that was refused');
    },
  );

  it(
    'leaves a terminal run row, so no reader is left waiting on it',
    {
      skip: !DB_HOST ? 'DB_HOST not set' : false,
    },
    async () => {
      // THIS IS THE HALF THAT IS EASY TO LOSE. A run that simply returned on a
      // parse failure would satisfy the case above perfectly, and would leave the
      // row `pending` forever: the pane reads the latest run, so the reader would
      // watch a spinner on every load and nothing in the system would ever clear
      // it.
      const run = await getRun(db, runIds[0] ?? '');
      assert.ok(run, 'the run row disappeared');
      assert.equal(run.status, 'failed');
      assert.notEqual(run.status, 'pending');
      assert.ok(run.finishedAt !== null, 'a failed run must carry a finish time');
      assert.ok((run.error ?? '') !== '', 'a failed run must say why');
      assert.equal(run.written, null, 'a failed run must claim no rows');
    },
  );
});
