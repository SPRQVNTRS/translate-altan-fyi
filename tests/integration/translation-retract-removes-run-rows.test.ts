/**
 * Retracting a run removes the rows it created, and only those.
 *
 * WHAT THIS FILE HOLDS IN PLACE
 *   Generated rows are permanent by default and sit in the same four tables as
 *   imported ones. "Permanent" is a policy, and a policy with no escape hatch is
 *   one bad prompt version away from a dictionary nobody can clean. The
 *   retraction is that hatch, and it has two obligations that pull against each
 *   other:
 *
 *   It must actually REMOVE the rows. A retraction that reported success and
 *   left the entry on the page would be worse than none, because the operator
 *   would believe the word was gone.
 *
 *   It must remove NOTHING ELSE. The ledger on the run row is what makes that
 *   possible, and this file proves it holds where it matters: a target headword
 *   the run merely reused stays, and so does a generated sense that another edge
 *   has since been attached to. Both are checked with rows that would be
 *   deleted by any implementation that worked from `source_id` instead.
 *
 * THE PRECONDITION IS A REACHABLE DATABASE. Every case gates on `DB_HOST`.
 *
 * NO LIVE API IS REACHABLE FROM THIS FILE.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { eq, inArray } from 'drizzle-orm';

import { getRawDb, pool } from '../../drizzle/db';
import { headwords, senseVersions, senses, translations } from '../../drizzle/schema';
import { PROMPT_VERSION } from '../../app/prompts/translation/version';
import { runTranslateHeadword } from '../../app/workflows/operations/translation/translate-headword';
import { createPendingRun, getRun, writtenRowIds } from '../../app/models/translation-runs.server';
import { getActiveModel } from '../../app/models/app-settings.server';
import { retractRows } from '../../cli/commands/translation';
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
/** The headword whose run is retracted in full. */
let plainHeadwordId = '';
/** The headword whose run reused an already-present target word. */
let reuseHeadwordId = '';
let reusedTargetId = '';
let freshTargetLemma = '';
let reusedTargetLemma = '';

/** Drive one whole run for `headwordId`, with a one-word answer, and return its run id. */
async function generate(headwordId: string, targetLemma: string, gloss: string): Promise<string> {
  fixture.fake.reset([
    llmValue({
      senses: [
        {
          localId: 's1',
          pos: 'noun',
          gloss,
          translations: [{ lemma: targetLemma, pos: 'noun', confidence: 'high' }],
        },
      ],
    }),
  ]);

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

  const summary = await runTranslateHeadword({
    headwordId,
    from: FROM,
    to: TO,
    promptVersion: PROMPT_VERSION,
    runId,
  });
  assert.equal(summary.outcome, 'written', summary.reason ?? '');
  return runId;
}

before(async () => {
  if (!DB_HOST) return;
  fixture = await setUpTranslationFixture('retract');
  freshTargetLemma = `zzyeni${fixture.run}`;
  reusedTargetLemma = `zzeski${fixture.run}`;

  plainHeadwordId = await seedHeadword(fixture, {
    lemma: `zzruecknahme${fixture.run}`,
    languageCode: FROM,
    pos: 'noun',
  });
  reuseHeadwordId = await seedHeadword(fixture, {
    lemma: `zzbehalten${fixture.run}`,
    languageCode: FROM,
    pos: 'noun',
  });

  // Stands in for an imported Turkish row: its own source, its own sense.
  reusedTargetId = await seedHeadword(fixture, {
    lemma: reusedTargetLemma,
    languageCode: TO,
    pos: 'noun',
  });
  await seedSense(fixture, { headwordId: reusedTargetId, gloss: 'eski', glossLanguageCode: TO });
});

after(async () => {
  if (!DB_HOST) {
    await pool.end();
    return;
  }
  await tearDownTranslationFixture(fixture, runIds);
  await pool.end();
});

describe('retracting a translation run', () => {
  it(
    'deletes the sense, the version, the target headword and the edge it created',
    {
      skip: !DB_HOST ? 'DB_HOST not set' : false,
    },
    async () => {
      const runId = await generate(plainHeadwordId, freshTargetLemma, 'die Ruecknahme');
      const created = await getRun(db, runId);
      assert.ok(created);
      const ledger = writtenRowIds(created);
      assert.equal(ledger.headwords.length, 1, 'the fixture did not produce a fresh target headword to delete');

      const report = await retractRows(db, created);

      assert.equal(report.removed.translations, 1);
      assert.equal(report.removed.senses, 2, "both the source sense and the target sense were this run's own");
      assert.equal(report.removed.senseVersions, 2);
      assert.equal(report.removed.headwords, 1);

      // THE TABLES, NOT THE REPORT. The report is what the code believes it did.
      const remainingSenses = await db.select({ id: senses.id }).from(senses).where(inArray(senses.id, ledger.senses));
      assert.equal(remainingSenses.length, 0, 'a generated sense survived the retraction');
      const remainingVersions = await db
        .select({ id: senseVersions.id })
        .from(senseVersions)
        .where(inArray(senseVersions.id, ledger.senseVersions));
      assert.equal(remainingVersions.length, 0);
      const remainingEdges = await db
        .select({ id: translations.id })
        .from(translations)
        .where(inArray(translations.id, ledger.translations));
      assert.equal(remainingEdges.length, 0);
      const remainingHeadwords = await db
        .select({ id: headwords.id })
        .from(headwords)
        .where(inArray(headwords.id, ledger.headwords));
      assert.equal(remainingHeadwords.length, 0, 'the generated target headword survived');

      // The source headword is NOT the run's, and must be untouched.
      const source = await db.select({ id: headwords.id }).from(headwords).where(eq(headwords.id, plainHeadwordId));
      assert.equal(source.length, 1, 'the retraction deleted the headword the reader had searched for');
    },
  );

  it(
    'stamps the run as retracted and leaves the run row itself in place',
    {
      skip: !DB_HOST ? 'DB_HOST not set' : false,
    },
    async () => {
      // The row survives on purpose. Deleting it would erase the record that the
      // rows ever existed, which is the one thing a retraction must not do: the
      // point is to be able to say what was published and that it was withdrawn.
      const run = await getRun(db, runIds[0] ?? '');
      assert.ok(run, 'the retraction deleted the run row');
      assert.ok(run.retractedAt !== null, 'the run was not stamped as retracted');
      assert.equal(run.status, 'ok', 'a retraction must not rewrite what the model actually did');
    },
  );

  it(
    'keeps a target headword the run only reused, and says it kept it',
    {
      skip: !DB_HOST ? 'DB_HOST not set' : false,
    },
    async () => {
      const runId = await generate(reuseHeadwordId, reusedTargetLemma, 'das Behalten');
      const run = await getRun(db, runId);
      assert.ok(run);

      const report = await retractRows(db, run);

      const survivor = await db.select({ id: headwords.id }).from(headwords).where(eq(headwords.id, reusedTargetId));
      assert.equal(
        survivor.length,
        1,
        'the retraction deleted a headword the run did not create. A retraction that worked from source_id ' +
          'instead of the run ledger would do exactly this.',
      );

      const survivingSenses = await db
        .select({ id: senses.id })
        .from(senses)
        .where(eq(senses.headwordId, reusedTargetId));
      assert.equal(survivingSenses.length, 1, 'the reused target sense was deleted');

      assert.equal(report.removed.headwords, 0, "nothing on the target side was this run's to delete");
      assert.equal(report.removed.translations, 1, "the edge itself was the run's own and should have gone");
      assert.equal(report.removed.senses, 1, 'only the source sense this run authored should have gone');
    },
  );
});
