/**
 * The translation job: have the active model write the senses of one headword
 * and their translations into one target language, and write what comes back
 * into the shared dictionary as permanent, attributed rows.
 *
 * THIS JOB GROWS THE CORPUS. IT IS NOT A CACHE.
 *   Everything it writes lands in `headwords`, `senses`, `sense_versions` and
 *   `translations`, the same four tables the importers write, carrying the
 *   generated source's id. Every later reader of the same pair is served those
 *   rows by the ordinary dictionary query and no model is called again. Nothing
 *   in this milestone expires, evicts or overwrites them.
 *
 * THE BODY IS A PLAIN FUNCTION, AND THE HANDLER IS FIVE LINES OVER IT.
 *   `runTranslateHeadword` takes a payload and returns a summary. It knows
 *   nothing about pg-boss, so a test drives the real thing with a faked provider
 *   port and no queue at all.
 *
 * EVERY EXIT PATH WRITES A TERMINAL RUN STATUS.
 *   The pane resolves what a reader sees from the LATEST `translation_runs` row
 *   for the key, and that row is opened `pending` by the request that queued the
 *   job. A run that ends without writing a terminal status is therefore not "a
 *   translation we did not get", it is a reader watching a spinner that will
 *   never stop, on every load, forever: nothing else in the system knows the job
 *   is gone. That is why the whole body sits inside one try/catch and the catch
 *   writes `failed`.
 *
 * THE ROWS GO IN ONE TRANSACTION, OR NOT AT ALL.
 *   A half-written answer is worse than no answer: a source sense with no
 *   translation edge under it is an entry that looks answered and is not, and it
 *   is indistinguishable from an imported sense that genuinely has no
 *   translation. The transaction is also what makes "a zod failure writes no
 *   dictionary row" true rather than hoped for.
 */

import { asc, eq, sql } from 'drizzle-orm';
import type { OperationHandler } from '@sprqvntrs/workflows';

import { reserve, settle } from '#app/lib/abuse/budget.server';
import { recordRejection } from '#app/lib/abuse/rate-limit.server';
import { getEntry, type EntrySense } from '#app/lib/dictionary/entry.server';
import { GENERATED_SOURCE_SLUG } from '#app/lib/dictionary/generated-source';
import { normalizeForLanguage } from '#app/lib/dictionary/normalize';
import type { Pos } from '#app/lib/dictionary/pos';
import type { DictionaryDb } from '#app/lib/dictionary/queries.server';
import { jsonValueSchema, type JsonValue } from '#app/lib/json';
import { estimateCostUsd, modelPrice } from '#app/lib/llm/catalog';
import { registry, type ActiveModel } from '#app/lib/llm/registry.server';
import {
  authoredTranslationAnswerSchema,
  existingSensesAnswerSchema,
  type AuthoredSense,
  type TranslationCandidate,
  type TranslationConfidence,
} from '#app/lib/llm/translation-schema';
import { createComponentLogger } from '#app/lib/logger';
import { MAX_SENSES, TRANSLATION_TIMEOUT_MS } from '#app/lib/translation/limits';
import type { TranslationJobPayload } from '#app/lib/translation/job-payload';
import { getActiveModel } from '#app/models/app-settings.server';
import { emptyWrittenRowIds, finishRun, getRun, type WrittenRowIds } from '#app/models/translation-runs.server';
import { renderTranslationPrompt, type OfferedSense } from '#app/prompts/translation';
import { headwords, senseVersions, senses, sources, translations } from '#drizzle/schema';
import { getRawDb } from '#drizzle/db';
import { translateHeadwordContextSchema } from '#app/workflows/types';

const log = createComponentLogger('TranslateHeadword');

// -----------------------------------------------------------------------------
// The spend estimate
// -----------------------------------------------------------------------------
// The reservation has to be taken BEFORE the call, so it is taken against a
// figure nobody has measured yet. These constants are that figure, and each is
// deliberately generous rather than accurate: an over-estimate reserves too much
// and is handed straight back by `settle`, while an under-estimate lets a run
// past a cap it should have hit.
// -----------------------------------------------------------------------------

/** Roughly four characters per token, for the Latin-script languages this dictionary serves. */
const CHARS_PER_TOKEN = 4;

/**
 * How many output tokens one sense's translations are expected to cost.
 *
 * Far smaller than enrichment's figure, and it should be: this answer is a list
 * of words with a part of speech and a confidence each, not three paragraphs of
 * study notes. It is still set well above what the prompt asks for, so a model
 * that rambles cannot spend past the cap by rambling.
 */
const EXPECTED_OUTPUT_TOKENS_PER_SENSE = 220;

/**
 * How many senses to price a zero-sense headword at.
 *
 * The reservation is taken before the answer arrives, and for the case this
 * feature exists for there are no senses yet to count. Pricing it at the ceiling
 * is the safe direction: it reserves for the largest answer the schema would
 * accept, so the cap binds on the worst case rather than on a guess.
 */
const AUTHORED_SENSE_ESTIMATE = MAX_SENSES;

/**
 * What to reserve for a model with no row in the price table.
 *
 * NEVER ZERO, AND THIS IS THE WHOLE REASON THE CONSTANT EXISTS. A zero estimate
 * adds nothing to the day's total, so a model the price table forgot would be
 * free forever: the cap would never be reached, no alert would ever fire, and
 * the guard would stop enforcing without once failing. A flat, deliberately high
 * figure means an unpriced model is throttled rather than unlimited.
 */
const UNPRICED_MODEL_RESERVE_USD = 0.05;

/** What one call is expected to cost, in USD. See the constants above for why each figure is high. */
function estimateRunCostUsd(model: string, prompt: string, senseCount: number): number {
  const price = modelPrice(model);
  if (price === null) return UNPRICED_MODEL_RESERVE_USD;

  const promptTokens = Math.ceil(prompt.length / CHARS_PER_TOKEN);
  const completionTokens = senseCount * EXPECTED_OUTPUT_TOKENS_PER_SENSE;
  return estimateCostUsd(price, promptTokens, completionTokens);
}

/**
 * The number that goes in `translations.confidence` for each level the model may
 * report.
 *
 * `satisfies Record<TranslationConfidence, number>` rather than an annotation, so
 * a fourth level added to the schema breaks this line at compile time instead of
 * writing `undefined` into a `real` column.
 *
 * The three figures are spaced, not scaled: they are read as "would print it",
 * "would offer it", "is guessing", and the gaps between them are what let a
 * later query rank or filter on the column. Nothing derives them from anything.
 */
const CONFIDENCE_VALUES = {
  high: 0.9,
  medium: 0.6,
  low: 0.3,
} satisfies Record<TranslationConfidence, number>;

/** What one run of the job did. */
export interface TranslationRunSummary {
  outcome: 'written' | 'skipped-not-configured' | 'skipped-no-entry' | 'skipped-no-run' | 'budget' | 'failed';
  /** The run row this job reported into, when there was one to report into. */
  runId: string | null;
  /** The ids this run inserted, per table. Empty on every outcome but `written`. */
  written: WrittenRowIds;
  /** True when the headword carries more senses than one run may cover. */
  capped: boolean;
  providerCalls: number;
  /** Why the run ended the way it did, when that is not obvious from the outcome. */
  reason: string | null;
}

/** A summary for a run that wrote nothing and called nothing. */
function emptySummary(
  outcome: TranslationRunSummary['outcome'],
  runId: string | null,
  reason: string | null,
): TranslationRunSummary {
  return { outcome, runId, written: emptyWrittenRowIds(), capped: false, providerCalls: 0, reason };
}

/** One sense on the source side, resolved to the row the edges will hang off. */
interface ResolvedSourceSense {
  senseId: string;
  candidates: TranslationCandidate[];
}

/** The prompt's view of one sense the dictionary already holds. */
function toOfferedSense(sense: EntrySense): OfferedSense {
  return { senseId: sense.senseId, glosses: sense.glosses.map((gloss) => gloss.gloss) };
}

/**
 * The generated source row's id.
 *
 * FAIL FAST, AND LOUDLY. The row has existed since the first migration and a
 * data migration fills in its licence and wording. If it is absent, every row
 * this job would write has nowhere to attribute to, and `source_id` is NOT NULL
 * on all four tables. Writing under some other source would silently mix
 * generated content into an imported dataset's attribution, which is the one
 * thing the provenance rule exists to prevent.
 */
async function readGeneratedSourceId(db: DictionaryDb): Promise<string> {
  const rows = await db.select({ id: sources.id }).from(sources).where(eq(sources.slug, GENERATED_SOURCE_SLUG));
  const row = rows[0];
  if (row === undefined) {
    throw new Error(
      `The generated source row '${GENERATED_SOURCE_SLUG}' is missing from 'sources'. ` +
        'Every generated dictionary row attributes to it, so nothing can be written without it. ' +
        'Run `pnpm cli data-migration run`.',
    );
  }
  return row.id;
}

/**
 * The database handle inside the write transaction.
 *
 * Named rather than inlined, because every helper below takes it and a
 * structural literal repeated six times is six places to get it wrong.
 */
type TransactionDb = Parameters<Parameters<DictionaryDb['transaction']>[0]>[0];

/** What one write pass needs to know, gathered before the transaction opens. */
interface WriteParams {
  payload: TranslationJobPayload;
  sourceHeadwordId: string;
  /** The language the source headword is written in. Its senses' glosses are written in it too. */
  from: string;
  to: string;
  /** The senses the model authored, when the headword had none. Empty otherwise. */
  authored: AuthoredSense[];
  /** The dictionary's own senses, translated, when the headword had some. Empty otherwise. */
  existing: ResolvedSourceSense[];
}

/**
 * Insert one sense and its first version, and record both ids.
 *
 * @param tx The transaction handle.
 * @param params The headword the sense belongs to, the gloss and the language it
 *   is written in, and the generated source id.
 * @param written The ledger this run is filling in.
 * @returns The new sense's id.
 */
async function insertSense(
  tx: TransactionDb,
  params: { headwordId: string; gloss: string; glossLanguageCode: string; sourceId: string },
  written: WrittenRowIds,
): Promise<string> {
  const [sense] = await tx
    .insert(senses)
    // `externalId` is left null: this sense has no upstream identity, we minted
    // it. The unique constraint on (source_id, external_id) keeps its default
    // NULLS DISTINCT behaviour precisely so that many id-less senses from one
    // source can coexist, which is what this job produces.
    .values({ headwordId: params.headwordId, sourceId: params.sourceId })
    .returning({ id: senses.id });
  if (!sense) throw new Error('Failed to insert a generated sense');
  written.senses.push(sense.id);

  const [version] = await tx
    .insert(senseVersions)
    .values({
      senseId: sense.id,
      // Version 1, because this is the first wording this sense has ever had.
      // `version` is re-enrichment order WITHIN one gloss language, not a
      // counter across the sense.
      version: 1,
      glossLanguageCode: params.glossLanguageCode,
      gloss: params.gloss,
      sourceId: params.sourceId,
    })
    .returning({ id: senseVersions.id });
  if (!version) throw new Error('Failed to insert a generated sense version');
  written.senseVersions.push(version.id);

  return sense.id;
}

/**
 * The target-language headword for one translation candidate, created or reused.
 *
 * IT UPSERTS ON THE IMPORTERS' OWN NATURAL KEY, `(language_code, lemma, pos)`,
 * and it normalises the lemma with `normalizeForLanguage`, which is the function
 * that wrote every existing `lemma_normalized`. Both halves matter. A different
 * conflict target would insert a second headword beside the imported one for the
 * same word, unreachable from it; a different normalisation would write a key no
 * search query can produce, so the new row would be invisible to the very reader
 * it was created for.
 *
 * `DO UPDATE` rather than `DO NOTHING`, for the reason `upsertHeadwords` gives:
 * `DO NOTHING` returns no row on a conflict, so a reused headword's id would come
 * back empty and the edge could not be built. The update itself is a near no-op,
 * writing the normalised lemma back from the excluded row.
 *
 * @returns the headword's id, and whether THIS statement inserted it. `xmax = 0`
 *   is how Postgres answers that: a row that was inserted rather than updated
 *   carries a zero there. It decides whether the id goes in the retraction
 *   ledger, and an imported headword this job merely reused must never go in it.
 */
async function upsertTargetHeadword(
  tx: TransactionDb,
  params: { languageCode: string; lemma: string; pos: Pos; sourceId: string },
): Promise<{ id: string; inserted: boolean }> {
  const [row] = await tx
    .insert(headwords)
    .values({
      languageCode: params.languageCode,
      lemma: params.lemma,
      lemmaNormalized: normalizeForLanguage(params.lemma, params.languageCode),
      pos: params.pos,
      sourceId: params.sourceId,
    })
    .onConflictDoUpdate({
      target: [headwords.languageCode, headwords.lemma, headwords.pos],
      set: { lemmaNormalized: sql`excluded.lemma_normalized` },
    })
    .returning({ id: headwords.id, inserted: sql<boolean>`(xmax = 0)` });

  if (!row) throw new Error(`Failed to upsert the target headword "${params.lemma}"`);
  return { id: row.id, inserted: row.inserted };
}

/**
 * The sense on the target headword that an edge may point at.
 *
 * An existing sense is REUSED, never duplicated: the oldest one, ordered by
 * `created_at` then `id` so the choice is deterministic across runs and a re-run
 * lands on the same row. Only a headword with no sense at all gets one minted,
 * and its gloss is the target lemma itself.
 *
 * THE TARGET GLOSS IS THE LEMMA, AND THAT IS A KNOWN WEAKNESS.
 *   `sense_versions.gloss` is NOT NULL, so a target sense has to say something,
 *   and the model was not asked what this word means in its own language: that
 *   is a second question, a longer answer and a bigger bill, for a line no
 *   reader of this direction is shown. The lemma is the truest thing available
 *   and it is never wrong. When the reverse direction is generated later, that
 *   run authors real glosses for the same headword, and they land as senses of
 *   their own beside this one.
 */
async function resolveTargetSense(
  tx: TransactionDb,
  params: { headwordId: string; lemma: string; languageCode: string; sourceId: string },
  written: WrittenRowIds,
): Promise<string> {
  const existing = await tx
    .select({ id: senses.id })
    .from(senses)
    .where(eq(senses.headwordId, params.headwordId))
    .orderBy(asc(senses.createdAt), asc(senses.id))
    .limit(1);

  const found = existing[0];
  if (found !== undefined) return found.id;

  return insertSense(
    tx,
    {
      headwordId: params.headwordId,
      gloss: params.lemma,
      glossLanguageCode: params.languageCode,
      sourceId: params.sourceId,
    },
    written,
  );
}

/**
 * One sense-to-sense edge, written or reused.
 *
 * Upserted on `(from_sense_id, to_sense_id, source_id)`, which is what makes a
 * re-run idempotent. The confidence is refreshed on a conflict, because a later
 * run under a better model is a better answer to the same question and the row
 * is the same edge either way.
 */
async function upsertTranslationEdge(
  tx: TransactionDb,
  params: { fromSenseId: string; toSenseId: string; sourceId: string; confidence: number },
  written: WrittenRowIds,
): Promise<void> {
  // The table's check constraint forbids an edge from a sense to itself. It
  // cannot arise from a correct answer, because the two senses hang off
  // headwords in different languages, but a constraint violation would roll the
  // whole transaction back and lose a good answer over a degenerate row.
  if (params.fromSenseId === params.toSenseId) return;

  const [row] = await tx
    .insert(translations)
    .values({
      fromSenseId: params.fromSenseId,
      toSenseId: params.toSenseId,
      sourceId: params.sourceId,
      confidence: params.confidence,
    })
    .onConflictDoUpdate({
      target: [translations.fromSenseId, translations.toSenseId, translations.sourceId],
      set: { confidence: params.confidence },
    })
    .returning({ id: translations.id, inserted: sql<boolean>`(xmax = 0)` });

  if (row?.inserted === true) written.translations.push(row.id);
}

/**
 * Write everything one answer produced, in one transaction.
 *
 * @returns The ids this run inserted, per table. Rows it merely reused are not
 *   in it, so a retraction cannot delete an imported headword.
 */
async function writeCorpusRows(db: DictionaryDb, params: WriteParams): Promise<WrittenRowIds> {
  const written = emptyWrittenRowIds();

  await db.transaction(async (tx) => {
    const sourceId = await readGeneratedSourceId(tx);

    // The source side. Either the model authored the senses, in which case they
    // are inserted here, or the dictionary already had them and they are used as
    // they are. Both branches end with the same list: a sense id and the words
    // that belong under it.
    const sourceSenses: ResolvedSourceSense[] = [...params.existing];
    for (const authored of params.authored) {
      const senseId = await insertSense(
        tx,
        {
          headwordId: params.sourceHeadwordId,
          // IN THE SOURCE LANGUAGE, which is what the prompt asked for. A gloss
          // stored under the wrong language code is invisible to the query that
          // renders it and impossible to find again.
          gloss: authored.gloss,
          glossLanguageCode: params.from,
          sourceId,
        },
        written,
      );
      sourceSenses.push({ senseId, candidates: authored.translations });
    }

    for (const sense of sourceSenses) {
      for (const candidate of sense.candidates) {
        const target = await upsertTargetHeadword(tx, {
          languageCode: params.to,
          lemma: candidate.lemma,
          pos: candidate.pos,
          sourceId,
        });
        if (target.inserted) written.headwords.push(target.id);

        const toSenseId = await resolveTargetSense(
          tx,
          { headwordId: target.id, lemma: candidate.lemma, languageCode: params.to, sourceId },
          written,
        );

        await upsertTranslationEdge(
          tx,
          {
            fromSenseId: sense.senseId,
            toSenseId,
            sourceId,
            confidence: CONFIDENCE_VALUES[candidate.confidence],
          },
          written,
        );
      }
    }
  });

  return written;
}

/**
 * The job body, callable without pg-boss so a test can drive it directly.
 *
 * @param payload The headword, the direction, the prompt version and the run row
 *   to report into.
 * @returns what happened. It reports rather than throws: a run that could not be
 *   done is a summary with a reason, and a terminal run row is written on every
 *   path out of here.
 */
export async function runTranslateHeadword(payload: TranslationJobPayload): Promise<TranslationRunSummary> {
  const db = getRawDb();

  const run = await getRun(db, payload.runId);
  if (run === null) {
    // Nothing to report into, so there is nothing a reader is waiting on either:
    // the pane reads runs, and this key has none. The job completes rather than
    // failing, because a retry would find the row just as absent.
    log.warn('Translation job has no run row', { runId: payload.runId, headwordId: payload.headwordId });
    return emptySummary('skipped-no-run', null, `No translation run row ${payload.runId}`);
  }

  // EVERYTHING BELOW IS INSIDE THE TRY. A throw anywhere, including a zod
  // failure inside the provider call and a constraint violation inside the
  // transaction, has to end as a `failed` run row. The alternative is a reader
  // watching a spinner forever; see the file comment.
  try {
    return await attemptTranslation(db, payload);
  } catch (cause) {
    const error = cause instanceof Error ? cause.message : String(cause);
    log.error('Translation run failed', { runId: payload.runId, headwordId: payload.headwordId, reason: error });
    await finishRun(db, payload.runId, { status: 'failed', error });
    return emptySummary('failed', payload.runId, error);
  }
}

/** The run proper. Every throw out of here is caught by `runTranslateHeadword`. */
async function attemptTranslation(db: DictionaryDb, payload: TranslationJobPayload): Promise<TranslationRunSummary> {
  // READ PER JOB, NEVER AT MODULE LOAD. Switching the model is an operator
  // action taken while the worker is running, and that is the whole point of
  // keeping the selection in a settings row.
  const active = await getActiveModel();

  const configuration = registry.describeConfiguration(active);
  if (!configuration.configured) {
    // An app deployed with no provider key is a normal state, not a fault. It is
    // still a terminal run: a reader must not be left waiting for a call that
    // this installation cannot make.
    await finishRun(db, payload.runId, { status: 'failed', error: configuration.reason });
    log.info('Translation skipped: no provider key', { reason: configuration.reason });
    return emptySummary('skipped-not-configured', payload.runId, configuration.reason);
  }

  const entry = await getEntry(db, { headwordId: payload.headwordId, to: payload.to });
  if (!entry) {
    const reason = `No servable entry for headword ${payload.headwordId}`;
    await finishRun(db, payload.runId, { status: 'failed', error: reason });
    return emptySummary('skipped-no-entry', payload.runId, reason);
  }

  // CAPPED MEANS THE MODEL WAS ASKED ABOUT FEWER SENSES THAN THE HEADWORD HAS.
  // It can only happen on the branch where the dictionary supplies the senses,
  // because the authoring branch starts from none. The pane needs it: a reader
  // shown four of eleven senses is not looking at a finished entry, and nothing
  // else on the row says so.
  const offered = entry.senses.slice(0, MAX_SENSES);
  const capped = entry.senses.length > offered.length;

  const prompt = renderTranslationPrompt({
    lemma: entry.lemma,
    pos: entry.pos,
    from: payload.from,
    to: payload.to,
    senses: offered.map(toOfferedSense),
  });

  const senseCount = offered.length === 0 ? AUTHORED_SENSE_ESTIMATE : offered.length;
  const estimateUsd = estimateRunCostUsd(active.model, prompt, senseCount);

  // RESERVE BEFORE THE CALL, ALWAYS. The reverse order, call first and count
  // after, has a window in which every parallel run reads the same low total and
  // every one of them charges. See `app/lib/abuse/budget.server.ts`.
  const reservation = await reserve(estimateUsd);
  if (!reservation.ok) {
    const error = 'The daily budget for this installation is used up. Please try again tomorrow.';
    await finishRun(db, payload.runId, { status: 'budget', error, capped });
    await recordRejection('budget');
    log.info('Translation refused by the daily budget', { headwordId: payload.headwordId, estimateUsd });
    return { ...emptySummary('budget', payload.runId, error), capped };
  }

  const startedAt = Date.now();
  const result = await callModel(active, prompt, offered);
  const latencyMs = Date.now() - startedAt;

  // THE CALL RAN, SO THE RESERVATION BECOMES A SPEND. It is settled here, above
  // everything that can still throw, because a throw from here on is caught by
  // `runTranslateHeadword` and must not leave the day's reservation stuck.
  //
  // IT IS NEVER RELEASED, AND THAT IS DELIBERATE. Enrichment releases when every
  // attempt rejected before an answer arrived, which is the one case that spent
  // nothing. This job cannot tell that case apart: the schema is handed to
  // `registry.complete`, so a model that answered badly and a model that never
  // answered both surface as one rejected promise, and the first of the two
  // burned the money. Releasing on both would hand out a free retry loop to
  // exactly the answers that fail validation. Settling on both is stricter than
  // the truth, and stricter is the safe direction for a spend cap.
  //
  // A NULL ACTUAL SETTLES AT THE ESTIMATE, NEVER AT ZERO. `costUsd` is null when
  // neither the client library nor our own table can price the model that ran,
  // and the call still cost money whatever our table says. Settling those at
  // zero would give exactly the models we cannot price an unlimited number of
  // free retries.
  await settle({ estimateUsd, actualUsd: result.costUsd ?? estimateUsd });

  const written = await writeCorpusRows(db, {
    payload,
    sourceHeadwordId: entry.headwordId,
    from: entry.languageCode,
    to: payload.to,
    authored: result.authored,
    existing: result.existing,
  });

  await finishRun(db, payload.runId, {
    status: 'ok',
    output: result.output,
    written,
    capped,
    costUsd: result.costUsd,
    latencyMs,
  });

  return { outcome: 'written', runId: payload.runId, written, capped, providerCalls: 1, reason: null };
}

/** What the model answered, already split into the two shapes the writer takes. */
interface ModelAnswer {
  /** The answer as it was parsed, for the run row. */
  output: JsonValue;
  authored: AuthoredSense[];
  existing: ResolvedSourceSense[];
  costUsd: number | null;
}

/**
 * Ask the model, once, under the schema that matches the branch.
 *
 * ONE ATTEMPT, AND NO RETRY LOOP. Enrichment retries once inside the job because
 * nobody is waiting for it; here a reader is, and a second 90 second call would
 * be spent on somebody who has already left. A failure ends the run `failed`,
 * and the pane offers a retry button, which is a new run and a new decision.
 *
 * THE PARSE HAPPENS INSIDE `registry.complete`, which is handed the schema. A
 * malformed answer therefore rejects the promise, and the rejection is caught by
 * `runTranslateHeadword` and written as a `failed` run with no dictionary row,
 * because nothing has been written by then.
 *
 * @param offered The senses the prompt listed. Empty means the authoring branch.
 */
async function callModel(active: ActiveModel, prompt: string, offered: EntrySense[]): Promise<ModelAnswer> {
  if (offered.length === 0) {
    const answer = await registry.complete(active, {
      prompt,
      schema: authoredTranslationAnswerSchema,
      // No reasoningEffort here. The active model's own `configured.reasoningEffort`
      // (an operator setting, see registry.server.ts) applies instead: some
      // endpoints, such as google/gemini-3.8-flash, reject a request that
      // disables reasoning outright with a 400. The ceiling on output is the
      // zod schema's caps and the prompt, not this job forcing a reasoning
      // level.
      timeoutMs: TRANSLATION_TIMEOUT_MS,
    });
    return {
      // Decoded rather than asserted. The value is already a validated object,
      // so this costs one cheap pass; what it buys is that the `output` column's
      // type is PROVEN at the one place a value enters it, instead of being
      // claimed by a cast that no test can fail.
      output: jsonValueSchema.parse(answer.output),
      authored: answer.output.senses,
      existing: [],
      costUsd: answer.costUsd,
    };
  }

  const answer = await registry.complete(active, {
    prompt,
    schema: existingSensesAnswerSchema(offered.map((sense) => sense.senseId)),
    // See the comment on the authoring branch above: no reasoningEffort here
    // either, for the same reason.
    timeoutMs: TRANSLATION_TIMEOUT_MS,
  });
  return {
    output: jsonValueSchema.parse(answer.output),
    authored: [],
    existing: answer.output.senses.map((sense) => ({ senseId: sense.senseId, candidates: sense.translations })),
    costUsd: answer.costUsd,
  };
}

/**
 * The pg-boss facing wrapper: decode the context, run the body, report it.
 *
 * A `failed` summary fails the operation, so the workflow record says so and the
 * run is visible on the admin surface. Every other outcome is a completion,
 * including `budget`: a run refused by the cap did exactly what it was asked to
 * do, and failing it would put the job back on the queue to be refused again,
 * which is a retry loop built out of the guard that exists to stop one.
 */
export const translateHeadwordHandler: OperationHandler = async (ctx) => {
  const payload = translateHeadwordContextSchema.parse(ctx.initialContext);
  const summary = await runTranslateHeadword(payload);
  if (summary.outcome === 'failed') {
    return { status: 'failed', reason: summary.reason ?? 'Translation failed' };
  }
  return {
    status: 'completed',
    data: {
      outcome: summary.outcome,
      runId: summary.runId,
      capped: summary.capped,
      providerCalls: summary.providerCalls,
      reason: summary.reason,
    },
  };
};
