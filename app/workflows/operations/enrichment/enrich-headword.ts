/**
 * The enrichment job: have the active model write study notes for the first few
 * senses of one headword, and record exactly what happened for every one of them.
 *
 * THE BODY IS A PLAIN FUNCTION, AND THE HANDLER IS FOUR LINES OVER IT.
 *   `runEnrichHeadword` takes a payload and returns a summary. It knows nothing
 *   about pg-boss, so a test drives the real thing with a faked provider port
 *   and no queue at all. The handler below is the only part that touches the
 *   workflow context, and it has no logic worth testing separately.
 *
 * EVERY PENDING SENSE LEAVES A ROW, WIN OR LOSE.
 *   The entry page waits until every sense it asked for has an answer. A sense
 *   that gets neither an `ok` row nor a `failed` row is therefore not "missing
 *   notes", it is a page that waits forever and re-queues the same job on every
 *   load. That is why a model that simply omits a sense still produces a failed
 *   row for it.
 *
 * NOT CONFIGURED IS NOT AN ERROR.
 *   An app deployed with no provider key is a normal state, not a fault. The job
 *   reports `skipped-not-configured` and completes.
 */

import type { OperationHandler } from '@sprqvntrs/workflows';

import { recordRejection } from '#app/lib/abuse/rate-limit.server';
import { release, reserve, settle } from '#app/lib/abuse/budget.server';
import type { EnrichmentJobPayload } from '#app/lib/enrichment/job-payload';
import { ENRICHMENT_SENSE_LIMIT, ENRICHMENT_TIMEOUT_MS } from '#app/lib/enrichment/limits';
import { getEntry, type EntrySense } from '#app/lib/dictionary/entry.server';
import { estimateCostUsd, modelPrice } from '#app/lib/llm/catalog';
import type { EnrichmentOutput, EnrichmentSenseOutput } from '#app/lib/llm/enrichment-schema';
import { enrichmentOutputSchema } from '#app/lib/llm/enrichment-schema';
import { createComponentLogger } from '#app/lib/logger';
import { registry, type ActiveModel } from '#app/lib/llm/registry.server';
import { getActiveModel } from '#app/models/app-settings.server';
import {
  listEnrichedSenseIds,
  recordEnrichment,
  recordEnrichmentFailure,
  type EnrichmentCacheKey,
} from '#app/models/enrichments.server';
import { renderEnrichmentPrompt } from '#app/prompts/enrichment';
import type { DictionaryDb } from '#app/lib/dictionary/queries.server';
import { getRawDb } from '#drizzle/db';
import { enrichHeadwordContextSchema } from '#app/workflows/types';

const log = createComponentLogger('EnrichHeadword');

/**
 * Two attempts, and the second one is the last.
 *
 * THE RETRY LIVES HERE, NOT INSIDE THE CLIENT AND NOT IN pg-boss.
 *   The caller owns the failure record: whatever happens, a row is written that
 *   says which model was asked and what it answered. A retry hidden inside the
 *   client would spend a second call that no metric and no row can see, and a
 *   pg-boss retry would re-run the whole job, re-read the cache and pay for a
 *   second answer under a different workflow id. Here, both attempts are counted
 *   into one summary and one set of rows.
 */
const MAX_PROVIDER_ATTEMPTS = 2;

// -----------------------------------------------------------------------------
// The spend estimate
// -----------------------------------------------------------------------------
// The reservation has to be taken BEFORE the call, so it is taken against a
// figure nobody has measured yet. These three constants are that figure, and
// each is deliberately generous rather than accurate: an over-estimate reserves
// too much and is handed straight back by `settle`, while an under-estimate lets
// a run past a cap it should have hit.
// -----------------------------------------------------------------------------

/**
 * The rule of thumb for turning a rendered prompt into a token count.
 *
 * Roughly four characters per token for the Latin-script languages this
 * dictionary serves. It is an approximation and it does not need to be better:
 * the reservation it feeds is reconciled against the provider's own count within
 * seconds.
 */
const CHARS_PER_TOKEN = 4;

/**
 * How many output tokens one sense's study notes are expected to cost.
 *
 * The output side dominates the price of these calls, so this is the number the
 * estimate actually turns on. It is set above the length the prompt asks for,
 * because a model that rambles must not be able to spend past the cap by
 * rambling.
 */
const EXPECTED_OUTPUT_TOKENS_PER_SENSE = 700;

/**
 * What to reserve for a model with no row in the price table.
 *
 * NEVER ZERO, AND THIS IS THE WHOLE REASON THE CONSTANT EXISTS. A zero estimate
 * adds nothing to the day's total, so a model the price table forgot would be
 * free forever: the cap would never be reached, no alert would ever fire, and
 * the guard would stop enforcing without once failing. That is the same trap
 * `modelPrice` returning `null` instead of a guessed zero exists to avoid, and
 * this is the other half of it. A flat, deliberately high figure means an
 * unpriced model is throttled rather than unlimited, which is the safe direction
 * to be wrong in.
 */
const UNPRICED_MODEL_RESERVE_USD = 0.05;

/** What one call is expected to cost, in USD. See the constants above for why each figure is high. */
function estimateRunCostUsd(model: string, prompt: string, pendingSenses: number): number {
  const price = modelPrice(model);
  if (price === null) return UNPRICED_MODEL_RESERVE_USD;

  const promptTokens = Math.ceil(prompt.length / CHARS_PER_TOKEN);
  const completionTokens = pendingSenses * EXPECTED_OUTPUT_TOKENS_PER_SENSE;
  return estimateCostUsd(price, promptTokens, completionTokens);
}

/** What one run of the job did. */
export interface EnrichmentRunSummary {
  outcome: 'written' | 'cached' | 'skipped-not-configured' | 'skipped-no-entry' | 'skipped-budget' | 'failed';
  writtenSenseIds: string[];
  failedSenseIds: string[];
  providerCalls: number;
  /** Why the run ended the way it did, when that is not obvious from the outcome. */
  reason: string | null;
}

/** The outcome of asking the provider, with everything the rows need. */
interface ProviderAttempts {
  result: { output: EnrichmentOutput; costUsd: number | null; latencyMs: number } | null;
  providerCalls: number;
  /** The last rejection's message, when every attempt failed. */
  error: string | null;
  /** Wall time across every attempt, so a failed row still records what the wait cost. */
  latencyMs: number;
}

/**
 * Ask the provider, once, and once more if the first attempt rejects.
 *
 * A timeout is an ordinary rejection here. There is nothing this job can tell
 * apart between a model that refused and a model that never answered, and both
 * produce the same failed row.
 */
async function callProvider(active: ActiveModel, prompt: string): Promise<ProviderAttempts> {
  const startedAt = Date.now();
  let providerCalls = 0;
  let error: string | null = null;

  while (providerCalls < MAX_PROVIDER_ATTEMPTS) {
    providerCalls += 1;
    try {
      const result = await registry.complete(active, {
        prompt,
        schema: enrichmentOutputSchema,
        timeoutMs: ENRICHMENT_TIMEOUT_MS,
      });
      return {
        result: { output: result.output, costUsd: result.costUsd, latencyMs: result.latencyMs },
        providerCalls,
        error: null,
        latencyMs: Date.now() - startedAt,
      };
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
      log.warn('Enrichment attempt rejected', { attempt: providerCalls, reason: error });
    }
  }

  return { result: null, providerCalls, error, latencyMs: Date.now() - startedAt };
}

/**
 * The answers, keyed by the sense id the model carried back.
 *
 * A returned sense id that was NOT pending is dropped here without ceremony, and
 * that is deliberate. It is either a sense already in the cache or an id the
 * model invented; writing it would either duplicate a paid-for row or attach
 * notes to a sense nobody asked about, and neither is worth a failed job.
 */
function indexBySenseId(output: EnrichmentOutput): Map<string, EnrichmentSenseOutput> {
  const bySenseId = new Map<string, EnrichmentSenseOutput>();
  for (const sense of output.senses) bySenseId.set(sense.senseId, sense);
  return bySenseId;
}

/** The prompt's view of one sense: its id, and the wording it already has. */
function toPromptSense(sense: EntrySense) {
  return { senseId: sense.senseId, glosses: sense.glosses.map((gloss) => gloss.gloss) };
}

/** Write one failed row per pending sense, all with the same reason. */
async function recordFailures(
  db: DictionaryDb,
  params: {
    payload: EnrichmentJobPayload;
    active: ActiveModel;
    senseIds: string[];
    error: string;
    latencyMs: number;
  },
): Promise<void> {
  for (const senseId of params.senseIds) {
    await recordEnrichmentFailure(db, {
      senseId,
      headwordId: params.payload.headwordId,
      from: params.payload.from,
      to: params.payload.to,
      provider: params.active.provider,
      model: params.active.model,
      promptVersion: params.payload.promptVersion,
      error: params.error,
      latencyMs: params.latencyMs,
    });
  }
}

/**
 * The job body, callable without pg-boss so a test can drive it directly.
 *
 * @param payload The headword, the direction, and the prompt version to enrich under.
 * @returns what happened, per sense. It reports rather than throws: a run that
 *   could not be done is a summary with a reason, and only an unexpected fault
 *   propagates.
 */
export async function runEnrichHeadword(payload: EnrichmentJobPayload): Promise<EnrichmentRunSummary> {
  const db = getRawDb();

  // READ PER JOB, NEVER AT MODULE LOAD. Switching the model is an operator
  // action taken while the worker is running, and that is the whole point of
  // keeping the selection in a settings row.
  const active = await getActiveModel();

  const configuration = registry.describeConfiguration(active);
  if (!configuration.configured) {
    log.info('Enrichment skipped: no provider key', { reason: configuration.reason });
    return emptySummary('skipped-not-configured', configuration.reason);
  }

  const entry = await getEntry(db, { headwordId: payload.headwordId, to: payload.to });
  if (!entry) {
    return emptySummary('skipped-no-entry', `No servable entry for headword ${payload.headwordId}`);
  }

  const target = entry.senses.slice(0, ENRICHMENT_SENSE_LIMIT);
  const key: EnrichmentCacheKey = {
    headwordId: payload.headwordId,
    from: payload.from,
    to: payload.to,
    model: active.model,
    promptVersion: payload.promptVersion,
  };
  const cached = new Set(await listEnrichedSenseIds(db, key));
  const pending = target.filter((sense) => !cached.has(sense.senseId));
  if (pending.length === 0) {
    return emptySummary('cached', null);
  }

  const prompt = renderEnrichmentPrompt({
    lemma: entry.lemma,
    pos: entry.pos,
    from: payload.from,
    to: payload.to,
    senses: pending.map(toPromptSense),
  });

  const pendingIds = pending.map((sense) => sense.senseId);
  const estimateUsd = estimateRunCostUsd(active.model, prompt, pending.length);

  // RESERVE BEFORE THE CALL, ALWAYS. The reverse order, call first and count
  // after, has a window in which every parallel run reads the same low total and
  // every one of them charges. See `app/lib/abuse/budget.server.ts`.
  const reservation = await reserve(estimateUsd);
  if (!reservation.ok) {
    // A REFUSED RUN STILL WRITES ROWS, AND THAT IS NOT BOOKKEEPING.
    //
    //   Returning quietly here would be the exact trap this file's header warns
    //   about. The entry page waits until every sense it asked for has an
    //   answer, so a sense that gets neither an `ok` row nor a `failed` row is
    //   not "notes we skipped today", it is a page that shows skeletons, waits,
    //   and re-queues the same job on EVERY load. A run refused for spending too
    //   much would therefore cause more queueing than a run that went ahead,
    //   which is the opposite of a cap.
    //
    //   A failed row terminates the wait at once, and it is not permanent:
    //   `ENRICHMENT_RETRY_AFTER_MS` is what lets tomorrow, under a fresh day's
    //   budget, ask again.
    const error = 'The daily enrichment budget for this installation is used up. Please try again tomorrow.';
    await recordFailures(db, { payload, active, senseIds: pendingIds, error, latencyMs: 0 });
    await recordRejection('budget');
    log.info('Enrichment refused by the daily budget', { headwordId: payload.headwordId, estimateUsd });
    return {
      outcome: 'skipped-budget',
      writtenSenseIds: [],
      failedSenseIds: pendingIds,
      providerCalls: 0,
      reason: error,
    };
  }

  const attempts = await callProvider(active, prompt);

  if (attempts.result === null) {
    // NOTHING WAS SPENT, SO THE RESERVATION GOES BACK. Every attempt rejected
    // before an answer arrived, which is the one case the gateway's rule calls a
    // release. A model that answered badly is NOT this case: that call burned
    // the money, and releasing it would hand out a free retry loop.
    await release(estimateUsd);

    // NEVER STORE A PARTIAL OR HALF-PARSED ANSWER. There is no half success to
    // record: the whole call produced nothing, so every pending sense gets a
    // failed row and the next run may try again.
    const error = attempts.error ?? 'The provider call failed with no reported reason';
    await recordFailures(db, { payload, active, senseIds: pendingIds, error, latencyMs: attempts.latencyMs });
    return {
      outcome: 'failed',
      writtenSenseIds: [],
      failedSenseIds: pendingIds,
      providerCalls: attempts.providerCalls,
      reason: error,
    };
  }

  // THE CALL RAN, SO THE RESERVATION BECOMES A SPEND.
  //
  // A NULL ACTUAL SETTLES AT THE ESTIMATE, NEVER AT ZERO. `costUsd` is null when
  // neither the client library nor our own table can price the model that ran,
  // and the call still cost money whatever our table says. Settling those at
  // zero would give exactly the models we cannot price an unlimited number of
  // free retries, which is the same hole a zero estimate opens at the other end.
  await settle({ estimateUsd, actualUsd: attempts.result.costUsd ?? estimateUsd });

  const answers = indexBySenseId(attempts.result.output);
  const writtenSenseIds: string[] = [];
  const failedSenseIds: string[] = [];

  for (const senseId of pendingIds) {
    const answer = answers.get(senseId);
    if (!answer) {
      failedSenseIds.push(senseId);
      await recordEnrichmentFailure(db, {
        senseId,
        headwordId: payload.headwordId,
        from: payload.from,
        to: payload.to,
        provider: active.provider,
        model: active.model,
        promptVersion: payload.promptVersion,
        error: 'The model returned no notes for this sense',
        latencyMs: attempts.result.latencyMs,
      });
      continue;
    }
    writtenSenseIds.push(senseId);
    await recordEnrichment(db, {
      senseId,
      headwordId: payload.headwordId,
      from: payload.from,
      to: payload.to,
      provider: active.provider,
      model: active.model,
      promptVersion: payload.promptVersion,
      output: answer,
      costUsd: attempts.result.costUsd,
      latencyMs: attempts.result.latencyMs,
    });
  }

  return {
    outcome: 'written',
    writtenSenseIds,
    failedSenseIds,
    providerCalls: attempts.providerCalls,
    reason: null,
  };
}

/** A summary for a run that wrote nothing and called nothing. */
function emptySummary(outcome: EnrichmentRunSummary['outcome'], reason: string | null): EnrichmentRunSummary {
  return { outcome, writtenSenseIds: [], failedSenseIds: [], providerCalls: 0, reason };
}

/**
 * The pg-boss facing wrapper: decode the context, run the body, report it.
 *
 * A `failed` summary fails the operation, so the workflow record says so and the
 * run is visible on the admin surface. Every other outcome is a completion,
 * including all three skips, because none of them is a fault to retry.
 * `skipped-budget` in particular must NOT fail the operation: a run refused by
 * the cap did exactly what it was asked to do, and failing it would put the job
 * back on the queue to be refused again, which is a retry loop built out of the
 * guard that exists to stop one.
 */
export const enrichHeadwordHandler: OperationHandler = async (ctx) => {
  const payload = enrichHeadwordContextSchema.parse(ctx.initialContext);
  const summary = await runEnrichHeadword(payload);
  if (summary.outcome === 'failed') {
    return { status: 'failed', reason: summary.reason ?? 'Enrichment failed' };
  }
  return {
    status: 'completed',
    data: {
      outcome: summary.outcome,
      writtenSenseIds: summary.writtenSenseIds,
      failedSenseIds: summary.failedSenseIds,
      providerCalls: summary.providerCalls,
      reason: summary.reason,
    },
  };
};
