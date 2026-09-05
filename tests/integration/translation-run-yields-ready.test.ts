/**
 * A zero-sense headword, one faked model answer, and the state the READ-ONLY
 * polling route reports once the run has written its rows.
 *
 * WHY THIS IS A DIFFERENT CLAIM FROM
 * `translation-run-writes-corpus.test.ts`. That file proves the job body
 * writes the right rows. This one proves the OTHER end of the chain: that
 * `GET /api/translation/:headwordId`, the exact route `TranslationSection`
 * polls every three seconds while a run is open, reports `ready` once those
 * rows exist, and stops the case on the state the UI stops on. A file that only
 * checked the table contents could pass while the polling route still read
 * `translating` forever.
 *
 * THE JOB BODY IS RUN DIRECTLY, NOT THROUGH A QUEUE. `runTranslateHeadword` is
 * the same function `translate-headword`'s workflow handler calls; running it
 * here in the foreground leaves exactly the rows a real run leaves, with no
 * worker and no provider ever started.
 *
 * NO LIVE API IS EVER REACHABLE FROM THIS FILE. `registry.withProvider`
 * installs a fake port through `setUpTranslationFixture`.
 *
 * ISOLATION. Every row carries a run-scoped suffix and is removed, in
 * foreign-key-safe order, through `tearDownTranslationFixture`, including the
 * target-side rows that hang off the SHARED generated source, and today's
 * `daily_budget` figures are put back.
 *
 * THE PRECONDITION IS A REACHABLE DATABASE. `DB_HOST`, nothing else.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { eq } from 'drizzle-orm';
import { RouterContextProvider } from 'react-router';
import { z } from 'zod';

import { GENERATED_SOURCE_SLUG } from '../../app/lib/dictionary/generated-source';
import { getRawDb, pool } from '../../drizzle/db';
import { headwords, senses, sources, translations } from '../../drizzle/schema';
import { getActiveModel } from '../../app/models/app-settings.server';
import { createPendingRun } from '../../app/models/translation-runs.server';
import { PROMPT_VERSION } from '../../app/prompts/translation/version';
import { loader as pollTranslation } from '../../app/routes/api.translation.$headwordId';
import { runTranslateHeadword } from '../../app/workflows/operations/translation/translate-headword';
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
let targetLemma = '';

/** Only what the polling route's cases below actually read. */
const polledPanelSchema = z.object({
  state: z.enum(['ready', 'translating', 'failed', 'budget', 'no-entry', 'none']),
  translations: z
    .array(z.object({ lemma: z.string(), pos: z.string().nullable(), confidence: z.number().nullable(), generated: z.boolean() }))
    .optional(),
});

/** Open a run the request path does, and remember it for cleanup. */
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

/** The exact hop `TranslationSection` polls: `/api/translation/<id>?to=<code>`. */
async function poll(): Promise<z.infer<typeof polledPanelSchema>> {
  const request = new Request(`https://kenning.altan.fyi/api/translation/${headwordId}?to=${TO}`);
  const response = await pollTranslation({
    request,
    url: new URL(request.url),
    params: { headwordId },
    pattern: '/api/translation/:headwordId',
    context: new RouterContextProvider(),
  });
  return polledPanelSchema.parse(await response.json());
}

before(async () => {
  if (!DB_HOST) return;
  fixture = await setUpTranslationFixture('run-ready');
  lemma = `zztransready${fixture.run}`;
  targetLemma = `zzhedefready${fixture.run}`;
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

describe('the state the polling route reports once a run finishes', () => {
  it(
    'is translating before the run, and ready with the generated rows after it',
    { skip: !DB_HOST ? 'DB_HOST not set' : false },
    async () => {
      const runId = await openRun();
      const opening = await poll();
      assert.equal(opening.state, 'translating', 'a pending run must poll as translating, not as anything else');

      fixture.fake.reset([
        llmValue({
          senses: [
            {
              localId: 's1',
              pos: 'verb',
              gloss: 'etwas zum Umfallen bringen',
              translations: [{ lemma: targetLemma, pos: 'verb', confidence: 'high' }],
            },
          ],
        }),
      ]);

      const summary = await runTranslateHeadword({ headwordId, from: FROM, to: TO, promptVersion: PROMPT_VERSION, runId });
      assert.equal(summary.outcome, 'written', summary.reason ?? '');

      // THE ROWS THEMSELVES, not only the polled answer: the source headword
      // gained a sense, a Turkish headword and sense exist to hang the edge
      // off, and all three carry the generated source id.
      const sourceSenses = await db.select().from(senses).where(eq(senses.headwordId, headwordId));
      assert.equal(sourceSenses.length, 1, 'a headword with zero senses should have gained exactly one');
      assert.equal(sourceSenses[0]?.sourceId, fixture.generatedSourceId);

      const target = await db.select().from(headwords).where(eq(headwords.lemma, targetLemma));
      assert.equal(target.length, 1, 'exactly one Turkish headword should have been created');
      assert.equal(target[0]?.languageCode, TO);
      assert.equal(target[0]?.sourceId, fixture.generatedSourceId);

      const targetSenses = await db
        .select()
        .from(senses)
        .where(eq(senses.headwordId, target[0]?.id ?? ''));
      assert.equal(targetSenses.length, 1, 'the target headword needs a sense to hang the edge off');
      assert.equal(targetSenses[0]?.sourceId, fixture.generatedSourceId);

      const edges = await db.select().from(translations).where(eq(translations.fromSenseId, sourceSenses[0]?.id ?? ''));
      assert.equal(edges.length, 1, 'no translation edge was written');
      assert.equal(edges[0]?.sourceId, fixture.generatedSourceId);

      // THE POLL, THE END OF THE CHAIN. `TranslationSection` stops polling
      // exactly when this state is `ready`.
      const settled = await poll();
      assert.equal(settled.state, 'ready', 'the poll never left translating, so the pane would spin forever');
      const rows = settled.translations ?? [];
      assert.equal(rows.length, 1, 'a ready panel with no rows is an empty card');
      assert.equal(rows[0]?.lemma, targetLemma);
      assert.equal(rows[0]?.generated, true, 'a generated edge must be marked generated, or the pane cites it as authored');

      // THE GENERATED SOURCE ROW ITSELF IS THE ONE THE FIXTURE ALREADY
      // RESOLVED, and it is the SHARED row every run in this database writes
      // under, confirmed by its slug rather than trusted by name.
      const [generated] = await db.select({ slug: sources.slug }).from(sources).where(eq(sources.id, fixture.generatedSourceId));
      assert.equal(generated?.slug, GENERATED_SOURCE_SLUG);
    },
  );
});
