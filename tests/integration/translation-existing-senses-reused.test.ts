/**
 * A headword that ALREADY has senses: the run translates them and authors none.
 *
 * WHAT THIS FILE HOLDS IN PLACE
 *   The dictionary's own senses are the source of truth about what a word means.
 *   A run that authored a second set beside them would split one headword's
 *   meanings across two provenances, so the entry page would show the same sense
 *   twice, once imported and once generated, and every later run would add
 *   another pair. The counsel adjustment behind this is "existing senses are
 *   handed to the model"; this file is what makes it a fact rather than an
 *   intention.
 *
 *   The second case is the other half: an answer naming a sense the prompt never
 *   offered must be REFUSED. Without that, a model that invents an id, or reuses
 *   one it saw earlier in its context, has its answer written against a sense
 *   nobody asked about, and the run still reports success.
 *
 * THE PRECONDITION IS A REACHABLE DATABASE
 *   `DB_HOST` and the other `DB_*` variables. Every case gates on `DB_HOST`
 *   alone, which `tests/unit/integration-tests-self-skip.test.ts` enforces.
 *
 * NO LIVE API IS REACHABLE FROM THIS FILE.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { eq } from 'drizzle-orm';

import { getRawDb, pool } from '../../drizzle/db';
import { senses, translations } from '../../drizzle/schema';
import { PROMPT_VERSION } from '../../app/prompts/translation/version';
import { runTranslateHeadword } from '../../app/workflows/operations/translation/translate-headword';
import { createPendingRun, getRun, writtenRowIds } from '../../app/models/translation-runs.server';
import { getActiveModel } from '../../app/models/app-settings.server';
import { createFakeLlmPort, llmValue } from '../fixtures/fake-llm-port';
import {
  seedHeadword,
  seedSense,
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
let seededSenseIds: string[] = [];

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
  fixture = await setUpTranslationFixture('existing');
  headwordId = await seedHeadword(fixture, {
    lemma: `zzhaben${fixture.run}`,
    languageCode: FROM,
    pos: 'verb',
  });
  seededSenseIds = [
    await seedSense(fixture, { headwordId, gloss: 'besitzen', glossLanguageCode: FROM }),
    await seedSense(fixture, { headwordId, gloss: 'als Hilfsverb gebrauchen', glossLanguageCode: FROM }),
  ];
});

after(async () => {
  if (!DB_HOST) {
    await pool.end();
    return;
  }
  await tearDownTranslationFixture(fixture, runIds);
  await pool.end();
});

describe('a translation run on a headword that already has senses', () => {
  it(
    'offers the existing sense ids to the model rather than authoring new ones',
    {
      skip: !DB_HOST ? 'DB_HOST not set' : false,
    },
    async () => {
      fixture.fake.reset([
        llmValue({
          senses: seededSenseIds.map((senseId, index) => ({
            senseId,
            translations: [{ lemma: `zzsahip${index}${fixture.run}`, pos: 'verb', confidence: 'medium' }],
          })),
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
      assert.equal(summary.outcome, 'written', summary.reason ?? '');

      // THE PROMPT IS INSPECTED, not just the outcome. A run that never showed the
      // model the sense ids could still pass every row assertion below by luck of
      // the fake's programmed answer, and would fail against a real model.
      const prompt = fixture.fake.calls[0]?.prompt ?? '';
      for (const senseId of seededSenseIds) {
        assert.ok(prompt.includes(senseId), `the prompt never showed the model sense ${senseId}`);
      }

      const sourceSenses = await db.select({ id: senses.id }).from(senses).where(eq(senses.headwordId, headwordId));
      assert.equal(
        sourceSenses.length,
        seededSenseIds.length,
        'the run authored a second set of senses beside the ones the dictionary already had',
      );

      const run = await getRun(db, runId);
      assert.ok(run);
      const written = writtenRowIds(run);
      assert.deepEqual(
        written.senses.toSorted(),
        written.senses.toSorted().filter((id) => !seededSenseIds.includes(id)),
        'the run claimed an imported sense as one of its own, so retracting it would delete imported data',
      );
      assert.equal(written.senses.length, 2, 'only the two TARGET senses should have been created');
      assert.equal(written.headwords.length, 2, 'one target headword per translated sense');
    },
  );

  it(
    'writes one edge per sense, from the sense the dictionary already had',
    {
      skip: !DB_HOST ? 'DB_HOST not set' : false,
    },
    async () => {
      for (const senseId of seededSenseIds) {
        const edges = await db.select().from(translations).where(eq(translations.fromSenseId, senseId));
        assert.equal(edges.length, 1, `sense ${senseId} got ${edges.length} edges, expected exactly one`);
        assert.equal(edges[0]?.sourceId, fixture.generatedSourceId);
        assert.equal(edges[0]?.confidence, 0.6, "a 'medium' confidence must be stored as 0.6");
      }
    },
  );

  it(
    'refuses an answer naming a sense that was never offered, and writes no row for it',
    {
      skip: !DB_HOST ? 'DB_HOST not set' : false,
    },
    async () => {
      const invented = '44444444-4444-4444-8444-444444444444';
      const sensesBefore = await db.select({ id: senses.id }).from(senses).where(eq(senses.headwordId, headwordId));

      fixture.fake.reset([
        llmValue({
          senses: [
            { senseId: invented, translations: [{ lemma: `zzuydurma${fixture.run}`, pos: 'noun', confidence: 'low' }] },
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

      assert.equal(summary.outcome, 'failed', 'an invented sense id was accepted');
      const run = await getRun(db, runId);
      assert.equal(run?.status, 'failed');
      assert.match(run?.error ?? '', /was not offered/, 'the failure did not say why the answer was refused');

      const sensesAfter = await db.select({ id: senses.id }).from(senses).where(eq(senses.headwordId, headwordId));
      assert.equal(sensesAfter.length, sensesBefore.length, 'a refused answer still changed the dictionary');
    },
  );
});
