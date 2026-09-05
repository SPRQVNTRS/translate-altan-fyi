/**
 * The translation run ledger: every attempt to grow the dictionary by a model
 * call, and the rows each attempt produced.
 *
 * THE DATABASE IS A PARAMETER, NEVER AN IMPORT.
 *   The same rule the dictionary queries and the enrichment cache follow, for
 *   the same reason: `drizzle/db.ts` opens a connection pool at module load, and
 *   this module is reached from three directions, a route loader holding
 *   `getRawDb()`, a workflow handler holding its own transaction handle, and the
 *   CLI. Only the TYPE is imported, so importing this file opens nothing.
 *
 * A RUN ROW IS PROVENANCE, NOT A CACHE.
 *   Nothing here decides whether a model is called again. The corpus rows the run
 *   wrote are what a later reader is served, and they are read out of the
 *   dictionary tables like any imported row. These rows exist so that "which
 *   model wrote this, when, at what cost, and which rows were its own" has an
 *   answer, and so that a run can be retracted.
 *
 * A ROW THAT CANNOT BE READ IS DROPPED, NEVER THROWN.
 *   `written` is JSONB, so the database cannot police its shape. A row written by
 *   an older version of this code may fail to parse later, and one such row must
 *   not take down the list it appears in. `writtenRowIds` returns empty lists for
 *   a row it cannot read, and the retraction path then deletes nothing, which is
 *   the safe direction to be wrong in.
 */

import { and, count, desc, eq, gte, inArray } from 'drizzle-orm';
import { z } from 'zod';

import type { LanguageCode } from '#app/lib/dictionary/detect-language';
import type { DictionaryDb } from '#app/lib/dictionary/queries.server';
import type { JsonValue } from '#app/lib/json';
import { createComponentLogger } from '#app/lib/logger';
import { translationRuns } from '#drizzle/schema';

const log = createComponentLogger('translation-runs');

/**
 * The four states a run can be in.
 *
 * `pending` is written by the request that enqueued the job, before the enqueue
 * returns. Everything else is terminal and is written exactly once, by the job.
 * `budget` is separated from `failed` because the two mean opposite things to a
 * reader: one is "come back tomorrow", the other is "try again".
 */
export const TRANSLATION_RUN_STATUSES = ['pending', 'ok', 'failed', 'budget'] as const;

/** One run's state. See `TRANSLATION_RUN_STATUSES`. */
export type TranslationRunStatus = (typeof TRANSLATION_RUN_STATUSES)[number];

/**
 * The ids one run inserted, per table.
 *
 * ONLY ROWS THE RUN GENUINELY CREATED. A target headword that already existed
 * and was reused is not listed, because a retraction must not delete an imported
 * row that a generated translation happened to point at.
 */
export const writtenRowIdsSchema = z.object({
  headwords: z.array(z.string()),
  senses: z.array(z.string()),
  senseVersions: z.array(z.string()),
  translations: z.array(z.string()),
});

/** The ids one run inserted, per table. */
export type WrittenRowIds = z.infer<typeof writtenRowIdsSchema>;

/** An empty ledger, which is what a run that wrote nothing records. */
export function emptyWrittenRowIds(): WrittenRowIds {
  return { headwords: [], senses: [], senseVersions: [], translations: [] };
}

/** One run, as a pane, the CLI or the retraction path reads it. */
export interface TranslationRunView {
  id: string;
  headwordId: string;
  from: string;
  to: string;
  promptVersion: number;
  provider: string;
  model: string;
  status: TranslationRunStatus;
  output: JsonValue | null;
  written: JsonValue | null;
  capped: boolean;
  error: string | null;
  /** USD, or null when neither pricing source could put a number on the call. */
  costUsd: number | null;
  latencyMs: number | null;
  createdAt: Date;
  finishedAt: Date | null;
  retractedAt: Date | null;
}

/** The columns every read in this file selects, so the views cannot drift apart. */
const RUN_COLUMNS = {
  id: translationRuns.id,
  headwordId: translationRuns.headwordId,
  from: translationRuns.fromLanguageCode,
  to: translationRuns.toLanguageCode,
  promptVersion: translationRuns.promptVersion,
  provider: translationRuns.provider,
  model: translationRuns.model,
  status: translationRuns.status,
  output: translationRuns.output,
  written: translationRuns.written,
  capped: translationRuns.capped,
  error: translationRuns.error,
  costUsd: translationRuns.costUsd,
  latencyMs: translationRuns.latencyMs,
  createdAt: translationRuns.createdAt,
  finishedAt: translationRuns.finishedAt,
  retractedAt: translationRuns.retractedAt,
};

/**
 * One selected row, before the two column conversions below are applied.
 *
 * Written out rather than inferred from `RUN_COLUMNS`, so the two places that
 * differ from `TranslationRunView` are visible: `status` is still a plain string
 * here, and `costUsd` is still the `numeric` column's string.
 */
interface RunRow {
  id: string;
  headwordId: string;
  from: string;
  to: string;
  promptVersion: number;
  provider: string;
  model: string;
  status: string;
  output: JsonValue | null;
  written: JsonValue | null;
  capped: boolean;
  error: string | null;
  costUsd: string | null;
  latencyMs: number | null;
  createdAt: Date;
  finishedAt: Date | null;
  retractedAt: Date | null;
}

/**
 * The status text, narrowed.
 *
 * The check constraint on the table is what makes this total, and the fallback
 * is `failed` rather than a throw: a status the constraint somehow let through
 * must not take down a list, and `failed` is the reading that stops a pane
 * waiting forever.
 */
function toStatus(value: string): TranslationRunStatus {
  const parsed = z.enum(TRANSLATION_RUN_STATUSES).safeParse(value);
  if (parsed.success) return parsed.data;
  log.warn('A translation run carries a status the code does not know', { status: value });
  return 'failed';
}

/**
 * `numeric` arrives as a string, and the conversion happens here, once.
 *
 * Postgres `numeric` holds values a JavaScript number cannot represent exactly,
 * so Drizzle carries the column as a string in both directions. This module is
 * the boundary where that string becomes a number, the same way
 * `app/models/enrichments.server.ts` is the boundary for its own `cost_usd`.
 */
function toCostUsd(value: string | null): number | null {
  return value === null ? null : Number(value);
}

function toView(row: RunRow): TranslationRunView {
  return { ...row, status: toStatus(row.status), costUsd: toCostUsd(row.costUsd) };
}

/** Everything a pending run row needs at the moment a reader asks for a translation. */
export interface CreatePendingRunParams {
  headwordId: string;
  from: LanguageCode;
  to: LanguageCode;
  promptVersion: number;
  provider: string;
  model: string;
}

/**
 * Open a run, `pending`, before the job is queued.
 *
 * WRITTEN FIRST, ON PURPOSE. The pane resolves its state from the latest run for
 * a key, so a job queued with no row behind it leaves a reader looking at "no
 * entry" while a model is already answering, and a reload re-enqueues. The row
 * is the promise that something is happening.
 *
 * @param db The database handle.
 * @param params The headword, the direction, the prompt version, and the model
 *   that is about to be asked. The model is recorded here rather than by the job
 *   so the row names the selection at the moment the reader asked, even if an
 *   operator switches models while the job waits.
 * @returns The new row's id, which becomes the job payload's `runId`.
 * @throws If the insert returns no row, which would mean a job whose every exit
 *   path writes to an id nothing holds.
 */
export async function createPendingRun(db: DictionaryDb, params: CreatePendingRunParams): Promise<string> {
  const [row] = await db
    .insert(translationRuns)
    .values({
      headwordId: params.headwordId,
      fromLanguageCode: params.from,
      toLanguageCode: params.to,
      promptVersion: params.promptVersion,
      provider: params.provider,
      model: params.model,
      status: 'pending',
    })
    .returning({ id: translationRuns.id });

  if (!row) throw new Error('Failed to open a translation run row');
  return row.id;
}

/** Which run to read. The direction is part of it: one headword has one run per pair. */
export interface LatestRunKey {
  headwordId: string;
  from: LanguageCode;
  to: LanguageCode;
}

/**
 * The newest run for one headword and one direction, or null when there is none.
 *
 * THE LATEST ROW IS THE STATE, and that is the whole reason this table is append
 * only. A failed run followed by a retry leaves two rows, and the reader's pane
 * must show the retry. Ordering on `created_at` desc is served by
 * `translation_runs_latest_idx`.
 *
 * @param db The database handle.
 * @param key The headword and the direction.
 * @returns The newest run, or null.
 */
export async function latestRun(db: DictionaryDb, key: LatestRunKey): Promise<TranslationRunView | null> {
  const rows = await db
    .select(RUN_COLUMNS)
    .from(translationRuns)
    .where(
      and(
        eq(translationRuns.headwordId, key.headwordId),
        eq(translationRuns.fromLanguageCode, key.from),
        eq(translationRuns.toLanguageCode, key.to),
      ),
    )
    .orderBy(desc(translationRuns.createdAt))
    .limit(1);

  const row = rows[0];
  return row === undefined ? null : toView(row);
}

/** One run by id, or null. The retraction path and the job body both start here. */
export async function getRun(db: DictionaryDb, runId: string): Promise<TranslationRunView | null> {
  const rows = await db.select(RUN_COLUMNS).from(translationRuns).where(eq(translationRuns.id, runId)).limit(1);
  const row = rows[0];
  return row === undefined ? null : toView(row);
}

/** How a run ends. Every field but `status` is optional, because a `budget` run has almost none of them. */
export interface FinishRunParams {
  status: Exclude<TranslationRunStatus, 'pending'>;
  output?: JsonValue;
  written?: WrittenRowIds;
  capped?: boolean;
  error?: string;
  costUsd?: number | null;
  latencyMs?: number;
}

/**
 * Write a run's terminal status.
 *
 * THE ONE UPDATE THIS TABLE ALLOWS, and the job calls it on EVERY exit path,
 * including the ones an exception takes. A run left `pending` is a reader
 * watching a spinner that will never stop, and no timeout anywhere would clear
 * it: nothing else in the system knows the job is gone.
 *
 * @param db The database handle.
 * @param runId The row opened by `createPendingRun`.
 * @param params The status and whatever the run has to show for itself.
 */
export async function finishRun(db: DictionaryDb, runId: string, params: FinishRunParams): Promise<void> {
  await db
    .update(translationRuns)
    .set({
      status: params.status,
      ...(params.output !== undefined && { output: params.output }),
      ...(params.written !== undefined && { written: params.written }),
      ...(params.capped !== undefined && { capped: params.capped }),
      ...(params.error !== undefined && { error: params.error }),
      // `costUsd` is threaded through even when it is null, because null is a
      // real answer here: it means the call ran and nothing could price it.
      ...(params.costUsd !== undefined && { costUsd: params.costUsd === null ? null : params.costUsd.toFixed(6) }),
      ...(params.latencyMs !== undefined && { latencyMs: params.latencyMs }),
      finishedAt: new Date(),
    })
    .where(eq(translationRuns.id, runId));
}

/**
 * Drop a run row that no job will ever finish.
 *
 * THE DEDUPE PATH, AND NOTHING ELSE CALLS IT. `enqueueTranslation` opens the row
 * before it queues, so a request that turns out to be a duplicate has already
 * written one. Leaving it `pending` would give the pane a run nobody is working
 * on; marking it `failed` would be worse, because the pane reads the LATEST row
 * and would then show a failure while the real job, whose row is older, is still
 * running. Removing it puts the truth back: the newest row for that key is the
 * in-flight one.
 *
 * @param db The database handle.
 * @param runId The row to remove. It is only ever a row this process just wrote.
 */
export async function deletePendingRun(db: DictionaryDb, runId: string): Promise<void> {
  await db.delete(translationRuns).where(and(eq(translationRuns.id, runId), eq(translationRuns.status, 'pending')));
}

/**
 * How many runs this installation has started today, UTC.
 *
 * `pending` AND `ok`, NOT `failed`. The count is what
 * `MAX_TRANSLATION_RUNS_PER_DAY` bounds, and that cap exists to bound how much
 * generated content lands in the shared dictionary in a day. A failed run wrote
 * nothing, so charging the day for it would let a provider outage lock the
 * feature out for everyone. A `pending` run DOES count: it is about to write.
 *
 * `budget` rows are excluded for the same reason as `failed`: a run refused by
 * a cap must not itself consume the cap, or the first refusal of the day would
 * push every later one further out of reach.
 *
 * @param db The database handle.
 * @param at The instant whose UTC day to count. Passed rather than read so the
 *   arithmetic is testable, the same rule `app/lib/abuse/budget.server.ts` uses.
 */
export async function countRunsToday(db: DictionaryDb, at: Date = new Date()): Promise<number> {
  const startOfDay = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
  const [row] = await db
    .select({ total: count() })
    .from(translationRuns)
    .where(and(gte(translationRuns.createdAt, startOfDay), inArray(translationRuns.status, ['pending', 'ok'])));
  return row?.total ?? 0;
}

/**
 * The most recent runs, newest first, for the operator CLI.
 *
 * @param db The database handle.
 * @param limit How many rows to return.
 */
export async function listRuns(db: DictionaryDb, limit: number): Promise<TranslationRunView[]> {
  const rows = await db.select(RUN_COLUMNS).from(translationRuns).orderBy(desc(translationRuns.createdAt)).limit(limit);
  return rows.map(toView);
}

/**
 * The ids one run inserted, decoded.
 *
 * @param run The run to read.
 * @returns The four id lists, or four empty lists when the column is absent or
 *   no longer parses. Empty means the retraction deletes nothing, which is the
 *   safe direction: a wrong list would delete rows another run owns.
 */
export function writtenRowIds(run: TranslationRunView): WrittenRowIds {
  if (run.written === null) return emptyWrittenRowIds();
  const parsed = writtenRowIdsSchema.safeParse(run.written);
  if (parsed.success) return parsed.data;
  log.warn('A translation run records rows in a shape this code cannot read', {
    runId: run.id,
    issues: parsed.error.issues.map((issue) => issue.path.join('.')).join(', '),
  });
  return emptyWrittenRowIds();
}

/**
 * Record that a run's rows were taken back.
 *
 * The row survives, for the reason written on the column: a retraction has to be
 * able to say what was published and that it was withdrawn. A second retraction
 * of the same run is a no-op rather than an error, because the CLI's delete step
 * is already idempotent.
 */
export async function markRetracted(db: DictionaryDb, runId: string, at: Date = new Date()): Promise<void> {
  await db.update(translationRuns).set({ retractedAt: at }).where(eq(translationRuns.id, runId));
}
