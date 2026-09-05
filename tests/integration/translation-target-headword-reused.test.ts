/**
 * An imported target headword must be REUSED, not shadowed by a generated copy.
 *
 * WHAT THIS FILE HOLDS IN PLACE
 *   `headwords` has one natural key, `(language_code, lemma, pos)`, and every
 *   importer upserts on it. A translation run creates target-side headwords, and
 *   if it wrote them on a different key, or normalised the lemma differently,
 *   the dictionary would end up holding the same Turkish word twice: once from
 *   the import with its senses and examples, once from the generation with the
 *   edge on it. Neither copy would be reachable from the other, no search would
 *   merge them, and every later run would attach to whichever it happened to
 *   find. This is the failure that has no visible symptom until somebody counts
 *   rows.
 *
 *   The second thing asserted here is that the reused row does NOT appear in the
 *   run's ledger. A retraction deletes what the ledger names, so an imported
 *   headword listed there would be deleted by an operator undoing a generated
 *   run.
 *
 * THE PRECONDITION IS A REACHABLE DATABASE. Every case gates on `DB_HOST`.
 *
 * NO LIVE API IS REACHABLE FROM THIS FILE.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { and, eq } from 'drizzle-orm';

import { getRawDb, pool } from '../../drizzle/db';
import { headwords, senses } from '../../drizzle/schema';
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
/** The pre-existing "imported" Turkish headword the run must land on. */
let importedTargetId = '';
let importedTargetSenseId = '';
let targetLemma = '';

before(async () => {
  if (!DB_HOST) return;
  fixture = await setUpTranslationFixture('reuse');
  targetLemma = `zzmevcut${fixture.run}`;

  headwordId = await seedHeadword(fixture, {
    lemma: `zzquelle${fixture.run}`,
    languageCode: FROM,
    pos: 'noun',
  });

  // Stands in for an imported row: a different source, a sense of its own, and
  // the exact natural key the model's answer will name.
  importedTargetId = await seedHeadword(fixture, {
    lemma: targetLemma,
    languageCode: TO,
    pos: 'noun',
  });
  importedTargetSenseId = await seedSense(fixture, {
    headwordId: importedTargetId,
    gloss: 'kaynak',
    glossLanguageCode: TO,
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

describe('a translation whose target word is already in the dictionary', () => {
  it(
    'lands on the existing headword instead of creating a second one',
    {
      skip: !DB_HOST ? 'DB_HOST not set' : false,
    },
    async () => {
      fixture.fake.reset([
        llmValue({
          senses: [
            {
              localId: 's1',
              pos: 'noun',
              gloss: 'Ursprung von etwas',
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

      const matching = await db
        .select({ id: headwords.id, sourceId: headwords.sourceId })
        .from(headwords)
        .where(and(eq(headwords.languageCode, TO), eq(headwords.lemma, targetLemma), eq(headwords.pos, 'noun')));

      assert.equal(
        matching.length,
        1,
        `the target word now exists ${matching.length} times. The upsert must name the importers own ` +
          'conflict target, (language_code, lemma, pos), or a generated copy shadows the imported row.',
      );
      assert.equal(matching[0]?.id, importedTargetId, 'the run created a new headword instead of reusing the old one');
      assert.equal(
        matching[0]?.sourceId,
        fixture.sourceId,
        "the reused headword was re-attributed to the generated source, which rewrites an import's provenance",
      );
    },
  );

  it(
    'reuses the existing sense under it rather than minting a second',
    {
      skip: !DB_HOST ? 'DB_HOST not set' : false,
    },
    async () => {
      const targetSenses = await db
        .select({ id: senses.id })
        .from(senses)
        .where(eq(senses.headwordId, importedTargetId));
      assert.equal(targetSenses.length, 1, 'the run added a sense to a target headword that already had one');
      assert.equal(targetSenses[0]?.id, importedTargetSenseId);
    },
  );

  it(
    'claims neither the reused headword nor the reused sense in its ledger',
    {
      skip: !DB_HOST ? 'DB_HOST not set' : false,
    },
    async () => {
      // A retraction deletes what the ledger names. An imported row listed here
      // would be deleted by an operator undoing a generated run, which is the one
      // way this feature could damage data it did not create.
      const run = await getRun(db, runIds[0] ?? '');
      assert.ok(run);
      const written = writtenRowIds(run);
      assert.equal(written.headwords.includes(importedTargetId), false, 'the run claimed an imported headword');
      assert.equal(written.senses.includes(importedTargetSenseId), false, 'the run claimed an imported sense');
      assert.equal(written.headwords.length, 0, 'no target headword needed creating in this case');
      assert.equal(written.translations.length, 1, 'the edge itself is the only new row on the target side');
    },
  );
});
