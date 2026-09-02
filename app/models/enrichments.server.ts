/**
 * The enrichment cache: read the notes a model already wrote, or record a new
 * attempt.
 *
 * THE DATABASE IS A PARAMETER, NEVER AN IMPORT.
 *   The same rule the dictionary queries follow, for the same reason:
 *   `drizzle/db.ts` opens a connection pool at module load, and this module is
 *   reached from two directions, a route loader holding `getRawDb()` and a
 *   workflow handler holding its own transaction handle. Only the TYPE is
 *   imported, so importing this file opens nothing.
 *
 * `enrichments` IS A GLOBAL TABLE.
 *   It carries no `organizationId` and is not in TENANT_TABLES, so `getRawDb()`
 *   is the correct handle and no `tdb.scope(...)` filter belongs on these
 *   statements. See the file comment in `drizzle/schema/enrichment.ts`.
 *
 * A ROW THAT CANNOT BE READ IS DROPPED, NEVER THROWN.
 *   `output` is JSONB, so the database cannot police its shape. A row written by
 *   an older prompt, or by a model that answered oddly, may fail to parse years
 *   after it was stored. One such row must not take down the entry page it
 *   appears on, so `listCachedEnrichments` skips it and logs it. The page then
 *   shows the notes it can read, which is the whole point of a cache.
 */

import { and, desc, eq } from 'drizzle-orm';
import type { LanguageCode } from '#app/lib/dictionary/detect-language';
import type { DictionaryDb } from '#app/lib/dictionary/queries.server';
import {
  enrichmentSenseSchema,
  type EnrichmentSenseOutput,
} from '#app/lib/llm/enrichment-schema';
import { createComponentLogger } from '#app/lib/logger';
import { enrichments } from '#drizzle/schema';

const log = createComponentLogger('enrichments');

/**
 * Everything that identifies a cached answer, for one headword.
 *
 * `headwordId` rather than `senseId`, because a page renders a whole headword
 * and wants every sense's notes in one read. The unique key in the table is at
 * sense level; this is the lookup that spans it.
 */
export interface EnrichmentCacheKey {
  headwordId: string;
  from: LanguageCode;
  to: LanguageCode;
  model: string;
  promptVersion: number;
}

/** One cached, validated enrichment, as a page renders it. */
export interface EnrichmentView {
  /**
   * The row's own id.
   *
   * CARRIED BECAUSE A VOTE POINTS AT A ROW, NOT AT A SENSE. A reader votes on
   * one cached ANSWER, and the same sense can hold several across models and
   * prompt versions, so the sense id cannot identify what was judged. The column
   * was already selected here, for the warning below, and then dropped on the
   * way out; carrying it costs nothing and is what lets the entry page attach a
   * vote to the exact text it showed.
   */
  id: string;
  senseId: string;
  provider: string;
  model: string;
  promptVersion: number;
  output: EnrichmentSenseOutput;
  createdAt: Date;
}

/**
 * The five columns that identify one cache key, with NO status filter.
 *
 * Split out from `matchesKey` because the reads in this file disagree about
 * status and agree about everything else. A cache read wants `ok` rows only; a
 * read that asks whether the last attempt failed must see the `failed` rows
 * too, and pinning the status here would silently hide exactly the rows that
 * question is about.
 */
function matchesCacheKey(key: EnrichmentCacheKey) {
  return [
    eq(enrichments.headwordId, key.headwordId),
    eq(enrichments.fromLanguageCode, key.from),
    eq(enrichments.toLanguageCode, key.to),
    eq(enrichments.model, key.model),
    eq(enrichments.promptVersion, key.promptVersion),
  ];
}

/** The predicate every CACHE read in this file shares: the key, plus `ok`. */
function matchesKey(key: EnrichmentCacheKey) {
  return and(...matchesCacheKey(key), eq(enrichments.status, 'ok'));
}

/**
 * Every `ok` row for this key, newest first, with unreadable rows dropped and
 * logged.
 *
 * @param db The database handle.
 * @param key The headword, direction, model and prompt version to read for.
 * @returns The parsed enrichments, newest first.
 */
export async function listCachedEnrichments(
  db: DictionaryDb,
  key: EnrichmentCacheKey,
): Promise<EnrichmentView[]> {
  const rows = await db
    .select({
      senseId: enrichments.senseId,
      provider: enrichments.provider,
      model: enrichments.model,
      promptVersion: enrichments.promptVersion,
      output: enrichments.output,
      createdAt: enrichments.createdAt,
      id: enrichments.id,
    })
    .from(enrichments)
    .where(matchesKey(key))
    .orderBy(desc(enrichments.createdAt));

  const views: EnrichmentView[] = [];
  for (const row of rows) {
    const parsed = enrichmentSenseSchema.safeParse(row.output);
    if (!parsed.success) {
      log.warn('Dropping an enrichment row whose stored output no longer parses', {
        enrichmentId: row.id,
        senseId: row.senseId,
        model: row.model,
        promptVersion: row.promptVersion,
        issues: parsed.error.issues.map((issue) => issue.path.join('.')).join(', '),
      });
      continue;
    }

    views.push({
      id: row.id,
      senseId: row.senseId,
      provider: row.provider,
      model: row.model,
      promptVersion: row.promptVersion,
      output: parsed.data,
      createdAt: row.createdAt,
    });
  }

  return views;
}

/**
 * The sense ids that already hold an `ok` row for this key.
 *
 * This is the skip list the workflow builds its batch from, so it deliberately
 * does NOT parse `output`: a row that exists but cannot be read is still a row
 * that was paid for, and re-enriching it would collide with the cache key
 * anyway.
 *
 * @param db The database handle.
 * @param key The headword, direction, model and prompt version to read for.
 * @returns The distinct sense ids already covered.
 */
export async function listEnrichedSenseIds(
  db: DictionaryDb,
  key: EnrichmentCacheKey,
): Promise<string[]> {
  const rows = await db
    .selectDistinct({ senseId: enrichments.senseId })
    .from(enrichments)
    .where(matchesKey(key));

  return rows.map((row) => row.senseId);
}

/**
 * Whether the NEWEST attempt at this key failed.
 *
 * WHY THE NEWEST ROW AND NOT "ANY FAILURE".
 *   Failures are appended, never updated, so a key that failed once and then
 *   succeeded still carries the old `failed` row forever. Asking whether any
 *   failure exists would therefore mark a perfectly enriched entry as broken.
 *   The newest row is the current fact: a retry that succeeded lands after the
 *   failure it replaces, and a retry that failed again lands after the first
 *   failure.
 *
 * The status is read raw rather than parsed, because the check constraint on
 * the column already pins it to `ok` or `failed`.
 *
 * @param db The database handle.
 * @param key The headword, direction, model and prompt version to read for.
 * @returns `true` when the latest row for the key is a failure.
 */
export async function latestAttemptFailed(db: DictionaryDb, key: EnrichmentCacheKey): Promise<boolean> {
  const latest = await latestAttempt(db, key);
  return latest !== null && latest.failed;
}

/** The newest attempt at a key: whether it failed, and when it landed. */
export interface LatestAttempt {
  failed: boolean;
  at: Date;
}

/**
 * The newest attempt at this key, or `null` when the key has none.
 *
 * WHY THE TIMESTAMP COMES BACK WITH THE VERDICT, IN ONE READ.
 *   `latestAttemptFailed` answers "is this key currently broken", which is
 *   enough to stop showing skeletons and not enough to decide anything else. A
 *   caller that also wants to know whether the failure is old enough to retry
 *   needs the instant it happened, and asking for it separately would be a
 *   second ordered read of the same rows that could land on a DIFFERENT newest
 *   row: a retry finishing between the two reads would give a verdict from one
 *   attempt and a timestamp from another. One read, one row, one fact.
 *
 * The rule `latestAttemptFailed` documents still governs: the NEWEST row only.
 * Failures are appended and never updated, so a key that failed once and then
 * succeeded still carries the old `failed` row forever, and asking whether any
 * failure exists would mark a perfectly enriched entry as broken.
 *
 * @param db The database handle.
 * @param key The headword, direction, model and prompt version to read for.
 * @returns The newest attempt's verdict and instant, or `null` for a key that
 *   has never been attempted.
 */
export async function latestAttempt(db: DictionaryDb, key: EnrichmentCacheKey): Promise<LatestAttempt | null> {
  const rows = await db
    .select({ status: enrichments.status, createdAt: enrichments.createdAt })
    .from(enrichments)
    .where(and(...matchesCacheKey(key)))
    .orderBy(desc(enrichments.createdAt))
    .limit(1);

  const row = rows[0];
  if (row === undefined) return null;
  return { failed: row.status === 'failed', at: row.createdAt };
}

/** One successful attempt, as the workflow reports it. */
export interface RecordEnrichmentParams {
  senseId: string;
  headwordId: string;
  from: LanguageCode;
  to: LanguageCode;
  provider: string;
  model: string;
  promptVersion: number;
  output: EnrichmentSenseOutput;
  /** `null` when the client's pricing table does not cover the model that ran. */
  costUsd: number | null;
  latencyMs: number;
}

/**
 * `cost_usd` is `numeric`, and Drizzle carries numerics as STRINGS in both
 * directions, because a Postgres numeric holds values a JavaScript number
 * cannot represent exactly. The workflow measures cost as a number, so the
 * conversion happens here, once, at six decimal places to match the column's
 * scale. Handing the number straight to Drizzle would be a type error, and
 * rounding it anywhere else would round it twice.
 */
function toNumericColumn(costUsd: number | null): string | null {
  return costUsd === null ? null : costUsd.toFixed(6);
}

/**
 * Write one successful row.
 *
 * IDEMPOTENT ON THE CACHE KEY: A CONCURRENT WINNER IS NOT AN ERROR.
 *   `onConflictDoNothing` swallows a collision with the partial unique index,
 *   and that is correct rather than merely convenient. A collision means two
 *   workers ran the same sense, in the same direction, on the same model, under
 *   the same prompt version, and therefore produced the same cache entry. The
 *   row that landed first is as good as the one that lost, so there is nothing
 *   to repair and nothing to report. Throwing here would turn a harmless race
 *   into a failed workflow run.
 *
 * @param db The database handle.
 * @param params The sense, the direction, the model, and what it answered.
 */
export async function recordEnrichment(
  db: DictionaryDb,
  params: RecordEnrichmentParams,
): Promise<void> {
  await db
    .insert(enrichments)
    .values({
      senseId: params.senseId,
      headwordId: params.headwordId,
      fromLanguageCode: params.from,
      toLanguageCode: params.to,
      provider: params.provider,
      model: params.model,
      promptVersion: params.promptVersion,
      status: 'ok',
      output: params.output,
      error: null,
      costUsd: toNumericColumn(params.costUsd),
      latencyMs: params.latencyMs,
    })
    .onConflictDoNothing();
}

/** One failed attempt, as the workflow reports it. */
export interface RecordEnrichmentFailureParams {
  senseId: string;
  headwordId: string;
  from: LanguageCode;
  to: LanguageCode;
  provider: string;
  model: string;
  promptVersion: number;
  error: string;
  latencyMs: number;
}

/**
 * Write one failed row.
 *
 * No conflict clause, and none is needed: the unique index covers `ok` rows
 * only, so a second failure at the same key is a second row on purpose. Two
 * outages are two facts.
 *
 * @param db The database handle.
 * @param params The sense, the direction, the model, and why it failed.
 */
export async function recordEnrichmentFailure(
  db: DictionaryDb,
  params: RecordEnrichmentFailureParams,
): Promise<void> {
  await db.insert(enrichments).values({
    senseId: params.senseId,
    headwordId: params.headwordId,
    fromLanguageCode: params.from,
    toLanguageCode: params.to,
    provider: params.provider,
    model: params.model,
    promptVersion: params.promptVersion,
    status: 'failed',
    output: null,
    error: params.error,
    costUsd: null,
    latencyMs: params.latencyMs,
  });
}
