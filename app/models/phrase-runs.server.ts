/**
 * The phrase ledger: every attempt to have a model translate one piece of
 * running text, and the answer the successful ones carry.
 *
 * THE DATABASE IS A PARAMETER, NEVER AN IMPORT.
 *   The same rule the dictionary queries and the run ledger follow, for the same
 *   reason: `drizzle/db.ts` opens a connection pool at module load, and this
 *   module is reached from three directions, a route loader holding
 *   `getRawDb()`, a workflow handler, and the unit tier, which has no database
 *   at all. Only the TYPE is imported, so importing this file opens nothing.
 *
 * A ROW IS BOTH THE RUN RECORD AND THE CACHE, which is the one way this table
 * differs from `translation_runs`. A word run's answer lands in the dictionary
 * and the run row is only provenance; a sentence has nowhere else to live, so
 * the `ok` row IS what a later reader is served. `latestPhraseAnswer` is that
 * read, and it is asked FIRST, before the state read, so a newer failed attempt
 * cannot hide an answer that already exists.
 *
 * THE FILE IS NAMED FOR THE RUN, NOT FOR THE TABLE, AND THAT IS DELIBERATE.
 *   The job that fills this table in is checked, by a grep in its own spec, to
 *   name none of the dictionary tables anywhere. A module path spelled with the
 *   table's name would fail that check on its import line alone, and the check
 *   is worth more than the symmetry: it is the executable form of "a sentence
 *   never reaches the dictionary".
 *
 * IT HOLDS NO READER. No account id, no session id, no device id, and no
 * function here takes one. See the header of `drizzle/schema/phrase-translations.ts`.
 */

import { and, count, desc, eq, gte, inArray } from 'drizzle-orm';
import { z } from 'zod';

import type { LanguageCode } from '#app/lib/dictionary/detect-language';
import type { DictionaryDb } from '#app/lib/dictionary/queries.server';
import { createComponentLogger } from '#app/lib/logger';
import { phraseTranslations } from '#drizzle/schema';

const log = createComponentLogger('phrase-translations');

/**
 * The four states a phrase row can be in.
 *
 * `pending` is written by the request that enqueued the job, before the enqueue
 * returns. Everything else is terminal and is written exactly once, by the job.
 * `budget` is separated from `failed` because the two mean opposite things to a
 * reader: one is "come back tomorrow", the other is "try again".
 */
export const PHRASE_STATUSES = ['pending', 'ok', 'failed', 'budget'] as const;

/** One phrase row's state. See `PHRASE_STATUSES`. */
export type PhraseStatus = (typeof PHRASE_STATUSES)[number];

/** One phrase row, as the resolver and the job read it. */
export interface PhraseTranslationView {
  id: string;
  from: string;
  to: string;
  sourceText: string;
  sourceNormalized: string;
  status: PhraseStatus;
  /** The answer, on an `ok` row. Null on every other status. */
  translationText: string | null;
  provider: string;
  model: string;
  promptVersion: number;
  /** USD, or null when neither pricing source could put a number on the call. */
  costUsd: number | null;
  latencyMs: number | null;
  error: string | null;
  createdAt: Date;
  finishedAt: Date | null;
}

/** The columns every read in this file selects, so the views cannot drift apart. */
const PHRASE_COLUMNS = {
  id: phraseTranslations.id,
  from: phraseTranslations.fromLanguageCode,
  to: phraseTranslations.toLanguageCode,
  sourceText: phraseTranslations.sourceText,
  sourceNormalized: phraseTranslations.sourceNormalized,
  status: phraseTranslations.status,
  translationText: phraseTranslations.translationText,
  provider: phraseTranslations.provider,
  model: phraseTranslations.model,
  promptVersion: phraseTranslations.promptVersion,
  costUsd: phraseTranslations.costUsd,
  latencyMs: phraseTranslations.latencyMs,
  error: phraseTranslations.error,
  createdAt: phraseTranslations.createdAt,
  finishedAt: phraseTranslations.finishedAt,
};

/**
 * One selected row, before the two column conversions below are applied.
 *
 * Written out rather than inferred from `PHRASE_COLUMNS`, so the two places that
 * differ from `PhraseTranslationView` are visible: `status` is still a plain
 * string here, and `costUsd` is still the `numeric` column's string.
 */
interface PhraseRow {
  id: string;
  from: string;
  to: string;
  sourceText: string;
  sourceNormalized: string;
  status: string;
  translationText: string | null;
  provider: string;
  model: string;
  promptVersion: number;
  costUsd: string | null;
  latencyMs: number | null;
  error: string | null;
  createdAt: Date;
  finishedAt: Date | null;
}

/**
 * The status text, narrowed.
 *
 * The check constraint on the table is what makes this total, and the fallback
 * is `failed` rather than a throw: a status the constraint somehow let through
 * must not take down a pane, and `failed` is the reading that stops one waiting
 * forever.
 */
function toStatus(value: string): PhraseStatus {
  const parsed = z.enum(PHRASE_STATUSES).safeParse(value);
  if (parsed.success) return parsed.data;
  log.warn('A phrase row carries a status the code does not know', { status: value });
  return 'failed';
}

/**
 * `numeric` arrives as a string, and the conversion happens here, once.
 *
 * Postgres `numeric` holds values a JavaScript number cannot represent exactly,
 * so Drizzle carries the column as a string in both directions. This module is
 * the boundary where that string becomes a number, the same way
 * `app/models/translation-runs.server.ts` is the boundary for its own column.
 */
function toCostUsd(value: string | null): number | null {
  return value === null ? null : Number(value);
}

function toView(row: PhraseRow): PhraseTranslationView {
  return { ...row, status: toStatus(row.status), costUsd: toCostUsd(row.costUsd) };
}

/** Everything a pending phrase row needs at the moment a reader asks. */
export interface CreatePendingPhraseParams {
  from: LanguageCode;
  to: LanguageCode;
  /** As typed, trimmed. It is what the model is shown. */
  sourceText: string;
  /** The folded form, which is the cache key. */
  sourceNormalized: string;
  promptVersion: number;
  provider: string;
  model: string;
}

/**
 * Open a phrase row, `pending`, before the job is queued.
 *
 * WRITTEN FIRST, ON PURPOSE. The pane resolves its state from the latest row for
 * a key, so a job queued with no row behind it leaves a reader looking at
 * nothing while a model is already answering, and a reload enqueues again. The
 * row is the promise that something is happening.
 *
 * @param db The database handle.
 * @param params The text, the direction, the prompt version, and the model that
 *   is about to be asked. The model is recorded here rather than by the job, so
 *   the row names the selection at the moment the reader asked even if an
 *   operator switches models while the job waits.
 * @returns The new row's id, which becomes the job payload's `runId`.
 * @throws If the insert returns no row, which would mean a job whose every exit
 *   path writes to an id nothing holds.
 */
export async function createPendingPhrase(db: DictionaryDb, params: CreatePendingPhraseParams): Promise<string> {
  const [row] = await db
    .insert(phraseTranslations)
    .values({
      fromLanguageCode: params.from,
      toLanguageCode: params.to,
      sourceText: params.sourceText,
      sourceNormalized: params.sourceNormalized,
      promptVersion: params.promptVersion,
      provider: params.provider,
      model: params.model,
      status: 'pending',
    })
    .returning({ id: phraseTranslations.id });

  if (!row) throw new Error('Failed to open a phrase translation row');
  return row.id;
}

/** Which rows to read: one direction, one folded sentence. */
export interface PhraseKey {
  from: LanguageCode;
  to: LanguageCode;
  sourceNormalized: string;
}

/** The two conditions every read below shares. */
function keyCondition(key: PhraseKey) {
  return and(
    eq(phraseTranslations.fromLanguageCode, key.from),
    eq(phraseTranslations.toLanguageCode, key.to),
    eq(phraseTranslations.sourceNormalized, key.sourceNormalized),
  );
}

/**
 * The newest ANSWERED row for one key, or null when there is none.
 *
 * THIS IS THE CACHE READ, AND IT IS THE ONE THAT MAKES THE SECOND READER FREE.
 * It is asked before the state read, so a later failed attempt cannot hide an
 * answer this installation has already paid for.
 *
 * @param db The database handle.
 * @param key The direction and the folded text.
 * @returns The newest `ok` row, or null.
 */
export async function latestPhraseAnswer(db: DictionaryDb, key: PhraseKey): Promise<PhraseTranslationView | null> {
  const rows = await db
    .select(PHRASE_COLUMNS)
    .from(phraseTranslations)
    .where(and(keyCondition(key), eq(phraseTranslations.status, 'ok')))
    .orderBy(desc(phraseTranslations.createdAt))
    .limit(1);

  const row = rows[0];
  return row === undefined ? null : toView(row);
}

/**
 * The newest row for one key whatever its status, or null when there is none.
 *
 * THE LATEST ROW IS THE STATE, and that is the whole reason this table is append
 * only. A failed run followed by a retry leaves two rows, and the reader's pane
 * must show the retry. Ordering on `created_at` desc is served by
 * `phrase_translations_latest_idx`.
 */
export async function latestPhrase(db: DictionaryDb, key: PhraseKey): Promise<PhraseTranslationView | null> {
  const rows = await db
    .select(PHRASE_COLUMNS)
    .from(phraseTranslations)
    .where(keyCondition(key))
    .orderBy(desc(phraseTranslations.createdAt))
    .limit(1);

  const row = rows[0];
  return row === undefined ? null : toView(row);
}

/** One row by id, or null. The job body starts here. */
export async function getPhrase(db: DictionaryDb, id: string): Promise<PhraseTranslationView | null> {
  const rows = await db.select(PHRASE_COLUMNS).from(phraseTranslations).where(eq(phraseTranslations.id, id)).limit(1);
  const row = rows[0];
  return row === undefined ? null : toView(row);
}

/** How a phrase run ends. Every field but `status` is optional, because a refused run has almost none of them. */
export interface FinishPhraseParams {
  status: Exclude<PhraseStatus, 'pending'>;
  /** The answer. Only ever passed with `ok`. */
  translationText?: string;
  error?: string;
  costUsd?: number | null;
  latencyMs?: number;
}

/**
 * Write a phrase row's terminal status.
 *
 * THE ONE UPDATE THIS TABLE ALLOWS, and the job calls it on EVERY exit path,
 * including the ones an exception takes. A row left `pending` is a reader
 * watching a spinner that will never stop, and no timeout anywhere would clear
 * it: nothing else in the system knows the job is gone.
 */
export async function finishPhrase(db: DictionaryDb, id: string, params: FinishPhraseParams): Promise<void> {
  await db
    .update(phraseTranslations)
    .set({
      status: params.status,
      ...(params.translationText !== undefined && { translationText: params.translationText }),
      ...(params.error !== undefined && { error: params.error }),
      // `costUsd` is threaded through even when it is null, because null is a
      // real answer here: it means the call ran and nothing could price it.
      ...(params.costUsd !== undefined && { costUsd: params.costUsd === null ? null : params.costUsd.toFixed(6) }),
      ...(params.latencyMs !== undefined && { latencyMs: params.latencyMs }),
      finishedAt: new Date(),
    })
    .where(eq(phraseTranslations.id, id));
}

/**
 * Drop a pending row that no job will ever finish.
 *
 * THE DEDUPE PATH, AND NOTHING ELSE CALLS IT. The enqueue opens the row before
 * it queues, so a request that turns out to be a duplicate has already written
 * one. Leaving it `pending` would give the pane a run nobody is working on;
 * marking it `failed` would be worse, because the pane reads the LATEST row and
 * would then show a failure while the real job, whose row is older, is still
 * running. Removing it puts the truth back.
 */
export async function deletePendingPhrase(db: DictionaryDb, id: string): Promise<void> {
  await db
    .delete(phraseTranslations)
    .where(and(eq(phraseTranslations.id, id), eq(phraseTranslations.status, 'pending')));
}

/**
 * How many phrase runs this installation has started today, UTC.
 *
 * `pending` AND `ok`, NOT `failed`. The count is what `MAX_PHRASE_RUNS_PER_DAY`
 * bounds, and that cap exists to bound how many paid calls a day can make. A
 * failed run produced no answer, so charging the day for it would let a provider
 * outage lock the feature out for everyone. A `pending` run DOES count: it is
 * about to call. `budget` rows are excluded for the same reason as `failed`: a
 * run refused by a cap must not itself consume the cap, or the first refusal of
 * the day would push every later one further out of reach.
 *
 * @param db The database handle.
 * @param at The instant whose UTC day to count. Passed rather than read so the
 *   arithmetic is testable, the same rule `app/lib/abuse/budget.server.ts` uses.
 */
export async function countPhraseRunsToday(db: DictionaryDb, at: Date = new Date()): Promise<number> {
  const startOfDay = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
  const [row] = await db
    .select({ total: count() })
    .from(phraseTranslations)
    .where(and(gte(phraseTranslations.createdAt, startOfDay), inArray(phraseTranslations.status, ['pending', 'ok'])));
  return row?.total ?? 0;
}

/**
 * The most recent phrase rows, newest first.
 *
 * THE OPERATOR'S HALF OF `translation runs`. There are two run tables now, and
 * an operator asking "what did we spend on" wants both, so the CLI reads this
 * beside `listRuns` and merges the two by time. It is deliberately the same
 * shape of question the word ledger answers, and deliberately NOT the same view:
 * a phrase run names a sentence where a word run names a headword id.
 *
 * @param db The database handle.
 * @param limit How many rows to return.
 */
export async function listPhraseRuns(db: DictionaryDb, limit: number): Promise<PhraseTranslationView[]> {
  const rows = await db
    .select(PHRASE_COLUMNS)
    .from(phraseTranslations)
    .orderBy(desc(phraseTranslations.createdAt))
    .limit(limit);
  return rows.map(toView);
}
