/**
 * The setup and teardown every translation integration case shares.
 *
 * WHY A FIXTURE AND NOT SIX COPIES
 *   Each of these files seeds a source, a headword and sometimes senses, fakes
 *   the provider, and then has to remove EXACTLY the rows it caused, out of
 *   tables the rest of the dictionary also lives in. The removal is the hard
 *   half: a translation run writes target headwords under the SHARED generated
 *   source row, so "delete everything attributed to the generated source" would
 *   delete another run's corpus. The ledger on the run row is what makes the
 *   cleanup exact, and doing that reasoning once is the point of this file.
 *
 * NO LIVE API IS REACHABLE THROUGH IT. `registry.withProvider` installs a fake
 * port, and the provider keys set here are dummies that exist only so
 * `configureActiveModel` finds the environment variable it demands. Their VALUES
 * are never used, because no real client is ever built.
 *
 * THE DAILY BUDGET ROW IS SHARED, AND IT IS PUT BACK.
 *   A run reserves and settles against today's `daily_budget` row, and the job
 *   does not take an instant, so the charge cannot be moved to a future day the
 *   way the abuse tests move theirs. The figures are fractions of a cent, and
 *   leaving them behind would still be a test that changed a shared counter. The
 *   row is therefore photographed in `setUpTranslationFixture` and written back
 *   in `tearDownTranslationFixture`.
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
import { z } from 'zod';

import { GENERATED_SOURCE_SLUG } from '../../app/lib/dictionary/generated-source';
import { registry } from '../../app/lib/llm/registry.server';
import { headwords, senseVersions, senses, sources, translationRuns, translations } from '../../drizzle/schema';
import { dailyBudget } from '../../drizzle/schema';
import { getRawDb, poolInitialized } from '../../drizzle/db';
import { createFakeLlmPort, type FakeLlmPort } from './fake-llm-port';
import type { JsonValue } from '../../app/lib/json';

/** The provider keys, set to a dummy so the registry's configuration check passes. */
const KEY_VARS = ['OPENROUTER_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY'] as const;
const DUMMY_KEY = 'stub-key-not-a-real-credential';

/** Today's budget figures, as strings, exactly as the columns hold them. */
interface BudgetSnapshot {
  day: string;
  reservedUsd: string;
  spentUsd: string;
}

/** Everything one file's cases need, and everything the teardown has to undo. */
export interface TranslationFixture {
  /** The source every SEEDED row carries. Never the generated one. */
  sourceId: string;
  /** The generated source row, which the job writes under. Shared, never deleted. */
  generatedSourceId: string;
  fake: FakeLlmPort;
  /** A short random string, on every lemma this run creates. */
  run: string;
  /** Headwords this file seeded, so teardown removes exactly them. */
  seededHeadwordIds: string[];
}

const savedKeys = new Map<string, string | undefined>();
let savedWebhook: string | undefined;
let budgetBefore: BudgetSnapshot | null = null;

/**
 * Seed the shared parts and install the fake provider.
 *
 * @param label A short word naming the file, so a leftover row can be traced
 *   back to the test that wrote it.
 */
export async function setUpTranslationFixture(label: string): Promise<TranslationFixture> {
  await poolInitialized;
  const db = getRawDb();

  for (const name of KEY_VARS) {
    savedKeys.set(name, process.env[name]);
    process.env[name] = DUMMY_KEY;
  }
  // A budget alert posts to this webhook when the day crosses its warning line.
  // A test must not be able to page anybody, so the variable is removed and put
  // back in the teardown.
  savedWebhook = process.env.ALERT_WEBHOOK_URL;
  delete process.env.ALERT_WEBHOOK_URL;

  const fake = createFakeLlmPort();
  registry.withProvider(fake);

  const run = randomUUID().slice(0, 8);
  const [source] = await db
    .insert(sources)
    .values({
      slug: `test-translation-${label}-${run}`,
      name: `test source ${run}`,
      // Served, so `getEntry` can see the seeded headword. An unserved licence
      // would make every case skip its own fixture and pass vacuously.
      licence: 'CC0-1.0',
      attribution: `test run ${run}`,
    })
    .returning({ id: sources.id });
  assert.ok(source, 'failed to create the test source');

  const [generated] = await db.select({ id: sources.id }).from(sources).where(eq(sources.slug, GENERATED_SOURCE_SLUG));
  assert.ok(
    generated,
    `the generated source row '${GENERATED_SOURCE_SLUG}' is missing. Run \`pnpm cli data-migration run\`.`,
  );

  const [budget] = await db
    .select({ day: dailyBudget.day, reservedUsd: dailyBudget.reservedUsd, spentUsd: dailyBudget.spentUsd })
    .from(dailyBudget)
    .where(eq(dailyBudget.day, utcDay()));
  budgetBefore = budget ?? null;

  return { sourceId: source.id, generatedSourceId: generated.id, fake, run, seededHeadwordIds: [] };
}

/** The UTC day key the budget row is stored under. */
function utcDay(at: Date = new Date()): string {
  return at.toISOString().slice(0, 10);
}

/**
 * Remove everything the file caused, in foreign-key-safe order, and restore the
 * shared state it touched.
 *
 * @param fixture The fixture returned by the setup.
 * @param runIds Every `translation_runs` row the file created. Their `written`
 *   ledgers name the rows to delete, which is the only exact way to reach the
 *   target-side rows: those hang off the SHARED generated source, so a delete by
 *   source id would take another run's corpus with it.
 */
export async function tearDownTranslationFixture(fixture: TranslationFixture, runIds: string[]): Promise<void> {
  const db = getRawDb();

  registry.withProvider(null);
  for (const [name, value] of savedKeys) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  savedKeys.clear();
  if (savedWebhook !== undefined) process.env.ALERT_WEBHOOK_URL = savedWebhook;

  const generated: Ledger = { headwords: [], senses: [], senseVersions: [], translations: [] };
  if (runIds.length > 0) {
    const rows = await db
      .select({ written: translationRuns.written })
      .from(translationRuns)
      .where(inArray(translationRuns.id, runIds));
    for (const row of rows) {
      const ledger = readLedger(row.written);
      generated.headwords.push(...ledger.headwords);
      generated.senses.push(...ledger.senses);
      generated.senseVersions.push(...ledger.senseVersions);
      generated.translations.push(...ledger.translations);
    }
  }

  // Order forced by the references: an edge points at two senses, a version
  // points at a sense, a sense points at a headword, a run points at a headword.
  if (generated.translations.length > 0) {
    await db.delete(translations).where(inArray(translations.id, generated.translations));
  }
  if (fixture.seededHeadwordIds.length > 0) {
    const seededSenses = await db
      .select({ id: senses.id })
      .from(senses)
      .where(inArray(senses.headwordId, fixture.seededHeadwordIds));
    const seededSenseIds = seededSenses.map((row) => row.id);
    if (seededSenseIds.length > 0) {
      await db.delete(translations).where(inArray(translations.fromSenseId, seededSenseIds));
      await db.delete(translations).where(inArray(translations.toSenseId, seededSenseIds));
      await db.delete(senseVersions).where(inArray(senseVersions.senseId, seededSenseIds));
      await db.delete(senses).where(inArray(senses.id, seededSenseIds));
    }
  }
  if (generated.senseVersions.length > 0) {
    await db.delete(senseVersions).where(inArray(senseVersions.id, generated.senseVersions));
  }
  if (generated.senses.length > 0) {
    await db.delete(senses).where(inArray(senses.id, generated.senses));
  }
  if (runIds.length > 0) {
    await db.delete(translationRuns).where(inArray(translationRuns.id, runIds));
  }
  if (fixture.seededHeadwordIds.length > 0) {
    await db.delete(translationRuns).where(inArray(translationRuns.headwordId, fixture.seededHeadwordIds));
  }
  if (generated.headwords.length > 0) {
    await db.delete(headwords).where(inArray(headwords.id, generated.headwords));
  }
  // Anything left under the test source, including headwords a case seeded and
  // did not track, plus the source row itself.
  await db.delete(senseVersions).where(eq(senseVersions.sourceId, fixture.sourceId));
  await db.delete(senses).where(eq(senses.sourceId, fixture.sourceId));
  await db.delete(headwords).where(eq(headwords.sourceId, fixture.sourceId));
  await db.delete(sources).where(eq(sources.id, fixture.sourceId));

  await restoreBudget();
}

/** Put today's budget figures back to what they were before the file ran. */
async function restoreBudget(): Promise<void> {
  const db = getRawDb();
  const day = utcDay();
  if (budgetBefore === null) {
    // There was no row for today, so the runs created one. Removing it is the
    // exact inverse.
    await db.delete(dailyBudget).where(eq(dailyBudget.day, day));
    return;
  }
  await db
    .update(dailyBudget)
    .set({ reservedUsd: budgetBefore.reservedUsd, spentUsd: budgetBefore.spentUsd })
    .where(eq(dailyBudget.day, day));
  budgetBefore = null;
}

/** The four id lists off a run row, tolerant of a row that has none. */
function readLedger(written: JsonValue | null): Ledger {
  const parsed = ledgerSchema.safeParse(written);
  return parsed.success ? parsed.data : { headwords: [], senses: [], senseVersions: [], translations: [] };
}

/** The four id lists a run row records. */
type Ledger = z.infer<typeof ledgerSchema>;

const ledgerSchema = z.object({
  headwords: z.array(z.string()),
  senses: z.array(z.string()),
  senseVersions: z.array(z.string()),
  translations: z.array(z.string()),
});

/** Seed one headword, with no senses, in `language`. */
export async function seedHeadword(
  fixture: TranslationFixture,
  params: { lemma: string; languageCode: string; pos: string },
): Promise<string> {
  const db = getRawDb();
  const [row] = await db
    .insert(headwords)
    .values({
      languageCode: params.languageCode,
      lemma: params.lemma,
      lemmaNormalized: params.lemma.toLowerCase(),
      pos: params.pos,
      sourceId: fixture.sourceId,
    })
    .returning({ id: headwords.id });
  assert.ok(row, `failed to seed the headword ${params.lemma}`);
  fixture.seededHeadwordIds.push(row.id);
  return row.id;
}

/** Seed one sense with one gloss under an existing headword. */
export async function seedSense(
  fixture: TranslationFixture,
  params: { headwordId: string; gloss: string; glossLanguageCode: string },
): Promise<string> {
  const db = getRawDb();
  const [sense] = await db
    .insert(senses)
    .values({ headwordId: params.headwordId, sourceId: fixture.sourceId, externalId: `${fixture.run}-${randomUUID()}` })
    .returning({ id: senses.id });
  assert.ok(sense, 'failed to seed the test sense');
  await db.insert(senseVersions).values({
    senseId: sense.id,
    version: 1,
    glossLanguageCode: params.glossLanguageCode,
    gloss: params.gloss,
    sourceId: fixture.sourceId,
  });
  return sense.id;
}
