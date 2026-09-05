/**
 * A zero-sense headword, one faked model answer, and the rows that answer leaves
 * in the shared dictionary.
 *
 * WHY A DB-BACKED TEST AT ALL
 *   Everything this feature is worth is in those rows. That a headword with NO
 *   senses gains one, that a Turkish headword and sense are created to hang the
 *   edge off, that all four kinds of row carry the generated source id, and that
 *   a second run adds nothing: every one of those is a claim about table
 *   contents under real unique indexes, and only a database can answer it. A
 *   unit test could assert the summary object and stay green while the
 *   dictionary never grew by a row.
 *
 *   The zero-sense case is not an edge case here, it is THE case. A translation
 *   is a sense-to-sense edge, so a headword with no sense can hold no
 *   translation ever, and about ninety three percent of the German headwords in
 *   this dictionary are in that state.
 *
 * THE PRECONDITION IS A REACHABLE DATABASE
 *   `DB_HOST` and the other `DB_*` variables, nothing else: no API key, and no
 *   server on :3456. Every case gates on `DB_HOST` alone, which
 *   `tests/unit/integration-tests-self-skip.test.ts` enforces.
 *
 * NO LIVE API IS REACHABLE FROM THIS FILE. The fixture installs a fake port
 * through `registry.withProvider` and restores the real one afterwards.
 *
 * ISOLATION
 *   Every row carries a run-scoped random suffix, and every row is deleted again
 *   in `after()`, in foreign-key-safe order, including the target-side rows that
 *   hang off the SHARED generated source. Today's `daily_budget` figures are put
 *   back to what they were.
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

/** Every run row this file opened, so teardown can read their ledgers. */
const runIds: string[] = [];

let headwordId = '';
let lemma = '';

/** Open a `pending` run the way the request path does, and remember it for cleanup. */
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
  fixture = await setUpTranslationFixture('corpus');
  lemma = `zztranslate${fixture.run}`;
  headwordId = await seedHeadword(fixture, { lemma, languageCode: FROM, pos: 'verb' });
});

after(async () => {
  if (!DB_HOST) {
    await pool.end();
    return;
  }
  await tearDownTranslationFixture(fixture, runIds);
  await pool.end();
});

describe('a translation run on a headword with no senses', () => {
  it(
    'writes senses, a target headword and a translation edge, all attributed to the generated source',
    {
      skip: !DB_HOST ? 'DB_HOST not set' : false,
    },
    async () => {
      const targetLemma = `zzhedef${fixture.run}`;
      fixture.fake.reset([
        llmValue(
          {
            senses: [
              {
                localId: 's1',
                pos: 'verb',
                gloss: 'etwas zum Umfallen bringen',
                translations: [{ lemma: targetLemma, pos: 'verb', confidence: 'high' }],
              },
            ],
          },
          0.000123,
        ),
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
      assert.equal(summary.providerCalls, 1, 'the happy path must cost exactly one call');
      assert.equal(fixture.fake.callCount, 1);

      // THE ROWS ARE THE ASSERTION THAT MATTERS. The summary is what this code
      // believes it did; the tables are what the reader will be served.
      const sourceSenses = await db.select().from(senses).where(eq(senses.headwordId, headwordId));
      assert.equal(sourceSenses.length, 1, `expected one generated sense, got ${sourceSenses.length}`);
      assert.equal(
        sourceSenses[0]?.sourceId,
        fixture.generatedSourceId,
        'the generated sense is not attributed to the generated source',
      );

      const glosses = await db
        .select()
        .from(senseVersions)
        .where(eq(senseVersions.senseId, sourceSenses[0]?.id ?? ''));
      assert.equal(glosses.length, 1);
      assert.equal(glosses[0]?.version, 1, 'the first wording of a sense is version 1');
      assert.equal(
        glosses[0]?.glossLanguageCode,
        FROM,
        'the authored gloss must be stored under the SOURCE language, or no query can find it',
      );
      assert.equal(glosses[0]?.gloss, 'etwas zum Umfallen bringen');

      const target = await db.select().from(headwords).where(eq(headwords.lemma, targetLemma));
      assert.equal(target.length, 1, 'exactly one target headword should have been created');
      assert.equal(target[0]?.languageCode, TO);
      assert.equal(target[0]?.pos, 'verb');
      assert.equal(target[0]?.sourceId, fixture.generatedSourceId);
      assert.equal(
        target[0]?.lemmaNormalized,
        targetLemma.toLowerCase(),
        'the target lemma was not normalised with the importers own function',
      );

      const targetSenses = await db
        .select()
        .from(senses)
        .where(eq(senses.headwordId, target[0]?.id ?? ''));
      assert.equal(targetSenses.length, 1, 'the target headword needs exactly one sense to hang the edge off');

      const edges = await db
        .select()
        .from(translations)
        .where(eq(translations.fromSenseId, sourceSenses[0]?.id ?? ''));
      assert.equal(edges.length, 1, 'no translation edge was written');
      assert.equal(edges[0]?.toSenseId, targetSenses[0]?.id);
      assert.equal(edges[0]?.sourceId, fixture.generatedSourceId);
      assert.equal(edges[0]?.confidence, 0.9, "a 'high' confidence must be stored as 0.9");
    },
  );

  it(
    'records the run as ok, with the cost, the answer and a ledger of every row it created',
    {
      skip: !DB_HOST ? 'DB_HOST not set' : false,
    },
    async () => {
      const run = await getRun(db, runIds[0] ?? '');
      assert.ok(run, 'the run row disappeared');
      assert.equal(run.status, 'ok');
      assert.equal(run.capped, false, 'a headword with no senses cannot be capped');
      assert.equal(run.costUsd, 0.000123, 'the cost the provider reported was not stored');
      assert.ok(run.latencyMs !== null && run.latencyMs >= 0, 'no latency was recorded');
      assert.ok(run.finishedAt !== null, 'a terminal run must carry a finish time');
      assert.ok(run.output !== null, 'the model answer was not stored on the run');

      // THE LEDGER IS WHAT MAKES A RUN RETRACTABLE. Without it there is no way to
      // tell a generated row from an imported one sitting in the same table.
      const written = writtenRowIds(run);
      assert.equal(written.senses.length, 2, 'one source sense and one target sense should be recorded');
      assert.equal(written.senseVersions.length, 2);
      assert.equal(written.headwords.length, 1, 'only the target headword was created by this run');
      assert.equal(written.translations.length, 1);
    },
  );

  it(
    'adds no row on a second run for the same pair',
    {
      skip: !DB_HOST ? 'DB_HOST not set' : false,
    },
    async () => {
      // The headword now HAS a sense, so the second run takes the other branch:
      // the dictionary supplies the sense and the model only translates it. That
      // is the path a real second reader takes, which is why it is the one asserted
      // here rather than a repeat of the authoring answer.
      const existing = await db.select({ id: senses.id }).from(senses).where(eq(senses.headwordId, headwordId));
      const senseId = existing[0]?.id ?? '';
      const targetLemma = `zzhedef${fixture.run}`;

      const countsBefore = await countCorpusRows();

      fixture.fake.reset([
        llmValue({
          senses: [{ senseId, translations: [{ lemma: targetLemma, pos: 'verb', confidence: 'high' }] }],
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

      const countsAfter = await countCorpusRows();
      assert.deepEqual(
        countsAfter,
        countsBefore,
        'a second run for the same pair created rows. The sense reuse and the two upserts are what ' +
          'make a re-run idempotent; a duplicate here is a dictionary that grows a copy of itself on ' +
          'every reader.',
      );

      const run = await getRun(db, runId);
      assert.ok(run, 'the second run row disappeared');
      const written = writtenRowIds(run);
      assert.deepEqual(
        written,
        { headwords: [], senses: [], senseVersions: [], translations: [] },
        "the second run claimed rows it did not create, so retracting it would delete the first run's corpus",
      );
    },
  );
});

/** The four counts this file's assertions turn on, for one headword and its target. */
async function countCorpusRows(): Promise<{ senses: number; versions: number; targets: number; edges: number }> {
  const sourceSenses = await db.select({ id: senses.id }).from(senses).where(eq(senses.headwordId, headwordId));
  const senseIds = sourceSenses.map((row) => row.id);
  const targets = await db
    .select({ id: headwords.id })
    .from(headwords)
    .where(eq(headwords.lemma, `zzhedef${fixture.run}`));
  const targetSenses =
    targets.length === 0 ?
      []
    : await db
        .select({ id: senses.id })
        .from(senses)
        .where(
          inArray(
            senses.headwordId,
            targets.map((row) => row.id),
          ),
        );
  const allSenseIds = [...senseIds, ...targetSenses.map((row) => row.id)];
  const versions =
    allSenseIds.length === 0 ?
      []
    : await db.select({ id: senseVersions.id }).from(senseVersions).where(inArray(senseVersions.senseId, allSenseIds));
  const edges =
    senseIds.length === 0 ?
      []
    : await db.select({ id: translations.id }).from(translations).where(inArray(translations.fromSenseId, senseIds));

  return {
    senses: sourceSenses.length + targetSenses.length,
    versions: versions.length,
    targets: targets.length,
    edges: edges.length,
  };
}
