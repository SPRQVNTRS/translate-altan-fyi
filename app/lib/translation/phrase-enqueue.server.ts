/**
 * Putting one sentence on the translation queue, and opening the row that
 * reports what happens to it.
 *
 * THE PAYLOAD IS THE PRIVACY BOUNDARY. THIS IS THE MOST IMPORTANT THING HERE.
 *   A queued job carries a folded sentence, a language pair and a row id, and
 *   NOTHING about who asked for it. The shape itself is written in
 *   `#app/lib/translation/phrase-job-payload`, which states the rule in full and
 *   carries no server import, so the unit tier can hold it to that rule with no
 *   database in front of it.
 *
 * THE ROW IS WRITTEN BEFORE THE ENQUEUE, IN THE SAME REQUEST.
 *   The pane resolves what to show from the LATEST row for a key. A job queued
 *   with no row behind it therefore leaves the reader on "nothing can happen"
 *   while a model is already answering, and the next load enqueues again. So the
 *   row comes first, `pending`, and its id travels in the payload.
 *
 * A PAGE MUST NEVER 500 BECAUSE THE QUEUE IS DOWN. Every failure mode here is a
 * return value, not a throw: a duplicate is `deduped`, an uninitialised
 * orchestrator is `unavailable`.
 *
 * IT SHARES THE `translation` QUEUE WITH THE WORD JOB, ON PURPOSE. The queue's
 * `stately` policy is what makes a singleton key bite at all, and it is set in
 * one place, `initializeWorkflows`. A second queue would need the same policy
 * set the same way and would split one worker pool in two for two jobs that are
 * the same size and answer the same reader. The keys are namespaced instead; see
 * `phraseSingletonKey`.
 */

import type { WorkflowOrchestrator } from '@sprqvntrs/workflows';
import { WorkflowError } from '@sprqvntrs/workflows';

import type { DictionaryDb } from '#app/lib/dictionary/queries.server';
import { createComponentLogger } from '#app/lib/logger';
import { phraseJobPayloadSchema, phraseSingletonKey, type PhraseJobPayload } from '#app/lib/translation/phrase-job-payload';
import { getActiveModel } from '#app/models/app-settings.server';
import { createPendingPhrase, deletePendingPhrase } from '#app/models/phrase-runs.server';
import { WORKFLOW_TYPES } from '#app/workflows/types';

const log = createComponentLogger('PhraseEnqueue');

export {
  phraseJobPayloadSchema,
  phraseSingletonKey,
  type PhraseJobPayload,
} from '#app/lib/translation/phrase-job-payload';

/**
 * What an enqueue did.
 *
 * `deduped` is a SUCCESS: the work is already queued or running, which is
 * exactly what the singleton key exists to arrange. The row id is carried back
 * on `queued` only, because that is the only case in which a row was left behind
 * for the caller to poll; a deduped caller polls by key and finds the row the
 * first caller opened.
 */
export type PhraseEnqueueResult =
  { outcome: 'queued'; runId: string } | { outcome: 'deduped'; runId: null } | { outcome: 'unavailable'; runId: null };

/** What a caller supplies. The row id is minted here, so it is not the caller's to pass. */
export interface PhraseEnqueueRequest {
  from: PhraseJobPayload['from'];
  to: PhraseJobPayload['to'];
  /** As typed, trimmed. It is what the model is shown and what the row stores. */
  sourceText: string;
  /** The folded form, which is the cache key and half the singleton key. */
  sourceNormalized: string;
  promptVersion: number;
}

/**
 * Open a row and queue one phrase job, at most once per key.
 *
 * @param db The database handle, so the row is written on the caller's
 *   connection rather than through a second import of the pool.
 * @param request The text, the direction and the prompt version. The row id is
 *   minted inside.
 * @returns which of the three things happened, and the row id when one was
 *   queued. It does not throw for a duplicate or for a missing orchestrator.
 */
export async function enqueuePhrase(db: DictionaryDb, request: PhraseEnqueueRequest): Promise<PhraseEnqueueResult> {
  const orchestrator = await readOrchestrator();
  // CHECKED BEFORE THE ROW IS WRITTEN. An orchestrator that is not up means
  // nothing will ever run, so opening a `pending` row first would leave a reader
  // watching a spinner for a job that was never queued.
  if (orchestrator === null) return { outcome: 'unavailable', runId: null };

  // READ PER REQUEST, NEVER MODULE-CACHED. Switching the model is an operator
  // action taken while the server is running, and the row has to name the
  // selection as it stood when the reader asked.
  const active = await getActiveModel();
  const runId = await createPendingPhrase(db, {
    from: request.from,
    to: request.to,
    sourceText: request.sourceText,
    sourceNormalized: request.sourceNormalized,
    promptVersion: request.promptVersion,
    provider: active.provider,
    model: active.model,
  });

  // Parsed again here even though the caller has a typed value, because this is
  // where the privacy rule is enforced and a compile-time type does not enforce
  // it against a value that arrived over HTTP. The text as typed is not part of
  // the payload, so it is not passed in.
  const parsed = phraseJobPayloadSchema.parse({
    from: request.from,
    to: request.to,
    sourceNormalized: request.sourceNormalized,
    promptVersion: request.promptVersion,
    runId,
  });
  const singletonKey = phraseSingletonKey(parsed);

  try {
    await orchestrator.start({ type: WORKFLOW_TYPES.TRANSLATE_PHRASE, context: parsed, singletonKey });
    return { outcome: 'queued', runId };
  } catch (cause) {
    // pg-boss returns null from `send` when a job with this singleton key is
    // already queued or active, and @sprqvntrs/workflows 0.2.5 turns that null
    // into a WorkflowError with code QUEUE_ERROR. That is the dedupe working, so
    // it is caught here rather than propagated. The match is on `code` rather
    // than on the message text, which is prose and may be reworded.
    //
    // THE ROW THIS JUST WROTE IS REMOVED, NOT MARKED FAILED. The pane reads the
    // LATEST row for a key. A `failed` row left here would be newer than the row
    // of the job that is actually running, so the reader would be told the
    // translation failed while it was in fact on its way.
    if (cause instanceof WorkflowError && cause.code === 'QUEUE_ERROR') {
      await deletePendingPhrase(db, runId);
      log.debug('A phrase job is already queued for this key', { singletonKey });
      return { outcome: 'deduped', runId: null };
    }
    // Any other rejection leaves no job either, so the row must not survive as a
    // spinner. The throw still propagates: this is not an expected state.
    await deletePendingPhrase(db, runId);
    throw cause;
  }
}

/**
 * The orchestrator, or null when it was never initialised.
 *
 * A deployment can serve pages with no worker behind it, in dev and during a
 * restart, and that is an ordinary state rather than an error.
 *
 * WHY THE IMPORT IS DYNAMIC, AND IT IS NOT ABOUT SPEED. A static import here is
 * an EDGE IN THE MODULE GRAPH, and the bundler follows it: route -> this file ->
 * workflows.server -> registerAllWorkflows -> every template -> every operation
 * handler -> the prompt modules, which read their markdown from disk. That chain
 * puts a file read on the boot path of the WEB server, which needs none of it to
 * queue one job. Deferring the import to the moment a job is actually queued
 * cuts the edge, and the `catch` covers the import as well as the call.
 */
async function readOrchestrator(): Promise<WorkflowOrchestrator | null> {
  try {
    const { getOrchestrator } = await import('#app/services/workflows.server');
    return getOrchestrator();
  } catch (cause) {
    log.warn('A phrase job was not queued: the workflow orchestrator is not initialised', {
      reason: cause instanceof Error ? cause.message : String(cause),
    });
    return null;
  }
}
