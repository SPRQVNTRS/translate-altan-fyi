/**
 * Putting one headword on the translation queue, and opening the run row that
 * reports what happens to it.
 *
 * THE PAYLOAD IS THE PRIVACY BOUNDARY. THIS IS THE MOST IMPORTANT THING HERE.
 *   A queued job carries a headword, a language pair and a run id, and NOTHING
 *   about who asked for it. This product's claim is that looking a word up does
 *   not build a record of the person looking it up, and a queue row pairing an
 *   account with a searched word would defeat that claim on its own, whatever
 *   the rest of the app does. The shape itself is written in
 *   `#app/lib/translation/job-payload`, which states the rule in full and carries
 *   no server import, so the unit tier can hold it to that rule with no database
 *   in front of it.
 *
 * THE RUN ROW IS WRITTEN BEFORE THE ENQUEUE, IN THE SAME REQUEST.
 *   The pane resolves what to show from the LATEST run for a key. A job queued
 *   with no row behind it therefore leaves the reader on "nothing can happen"
 *   while a model is already answering, and the next load enqueues again. So the
 *   row comes first, `pending`, and its id travels in the payload.
 *
 * A PAGE MUST NEVER 500 BECAUSE THE QUEUE IS DOWN. A search result is already a
 * result without a generated translation, so every failure mode here is a return
 * value, not a throw: a duplicate is `deduped`, an uninitialised orchestrator is
 * `unavailable`.
 */

import type { WorkflowOrchestrator } from '@sprqvntrs/workflows';
import { WorkflowError } from '@sprqvntrs/workflows';

import { createComponentLogger } from '#app/lib/logger';
import {
  translationJobPayloadSchema,
  translationSingletonKey,
  type TranslationJobPayload,
} from '#app/lib/translation/job-payload';
import { getActiveModel } from '#app/models/app-settings.server';
import { createPendingRun, deletePendingRun } from '#app/models/translation-runs.server';
import type { DictionaryDb } from '#app/lib/dictionary/queries.server';
import { WORKFLOW_TYPES } from '#app/workflows/types';

const log = createComponentLogger('TranslationEnqueue');

// The payload rules live in a module with no server imports, so the unit tier
// can test them without a database. They are re-exported here because this is
// the contract's public face: a caller enqueues, and never thinks about where
// the schema is written.
export {
  translationJobPayloadSchema,
  translationSingletonKey,
  type TranslationJobPayload,
} from '#app/lib/translation/job-payload';

/**
 * What an enqueue did.
 *
 * `deduped` is a SUCCESS: the work is already queued or running, which is
 * exactly what the singleton key exists to arrange. The run id is carried back
 * on `queued` only, because that is the only case in which a row was left
 * behind for the caller to poll; a deduped caller polls by key, through
 * `latestRun`, and finds the run the first caller opened.
 */
export type TranslationEnqueueResult =
  { outcome: 'queued'; runId: string } | { outcome: 'deduped'; runId: null } | { outcome: 'unavailable'; runId: null };

/** What an enqueue did, without the run id. Handy where only the branch matters. */
export type TranslationEnqueueOutcome = TranslationEnqueueResult['outcome'];

/** The payload a caller supplies. The run id is minted here, so it is not the caller's to pass. */
export type TranslationEnqueueRequest = Omit<TranslationJobPayload, 'runId'>;

/**
 * Open a run and queue one translation job, at most once per key.
 *
 * @param db The database handle, so the run row is written on the caller's
 *   connection rather than through a second import of the pool.
 * @param request The headword, the direction and the prompt version. The run id
 *   is minted inside.
 * @returns which of the three things happened, and the run id when one was
 *   queued. It does not throw for a duplicate or for a missing orchestrator.
 */
export async function enqueueTranslation(
  db: DictionaryDb,
  request: TranslationEnqueueRequest,
): Promise<TranslationEnqueueResult> {
  const orchestrator = await readOrchestrator();
  // CHECKED BEFORE THE ROW IS WRITTEN. An orchestrator that is not up means
  // nothing will ever run, so opening a `pending` row first would leave a reader
  // watching a spinner for a job that was never queued.
  if (orchestrator === null) return { outcome: 'unavailable', runId: null };

  // READ PER REQUEST, NEVER MODULE-CACHED. Switching the model is an operator
  // action taken while the server is running, and the row has to name the
  // selection as it stood when the reader asked.
  const active = await getActiveModel();
  const runId = await createPendingRun(db, {
    headwordId: request.headwordId,
    from: request.from,
    to: request.to,
    promptVersion: request.promptVersion,
    provider: active.provider,
    model: active.model,
  });

  // Parsed again here even though the caller has a typed value, because this is
  // where the privacy rule is enforced and a compile-time type does not enforce
  // it against a value that arrived over HTTP.
  const parsed = translationJobPayloadSchema.parse({ ...request, runId });
  const singletonKey = translationSingletonKey(parsed);

  try {
    await orchestrator.start({
      type: WORKFLOW_TYPES.TRANSLATE_HEADWORD,
      context: parsed,
      singletonKey,
    });
    return { outcome: 'queued', runId };
  } catch (cause) {
    // pg-boss returns null from `send` when a job with this singleton key is
    // already queued or active, and @sprqvntrs/workflows 0.2.5 turns that null
    // into a WorkflowError with code QUEUE_ERROR. That is the dedupe working,
    // so it is caught here rather than propagated. The match is on `code`
    // rather than on the message text, which is prose and may be reworded.
    //
    // THE ROW THIS JUST WROTE IS REMOVED, NOT MARKED FAILED. The pane reads the
    // LATEST run for a key. A `failed` row left here would be newer than the row
    // of the job that is actually running, so the reader would be told the
    // translation failed while it was in fact on its way. Deleting it restores
    // the truth: the newest row for the key is the in-flight one.
    //
    // THE WART THIS PAPERS OVER: `start()` creates the workflow row BEFORE it
    // sends the job, so a deduped enqueue leaves a workflow row behind with no
    // job id under it. That row is inert, nothing polls it, but anyone counting
    // rows in `workflows` should know they are not counting jobs.
    if (cause instanceof WorkflowError && cause.code === 'QUEUE_ERROR') {
      await deletePendingRun(db, runId);
      log.debug('Translation already queued for this key', { singletonKey });
      return { outcome: 'deduped', runId: null };
    }
    // Any other rejection leaves no job either, so the row must not survive as a
    // spinner. The throw still propagates: this is not an expected state.
    await deletePendingRun(db, runId);
    throw cause;
  }
}

/**
 * The orchestrator, or null when it was never initialised.
 *
 * A deployment can serve pages with no worker behind it, in dev and during a
 * restart, and that is an ordinary state rather than an error.
 *
 * WHY THE IMPORT IS DYNAMIC, AND IT IS NOT ABOUT SPEED.
 *   A static import here is an EDGE IN THE MODULE GRAPH, and the bundler follows
 *   it: route -> this file -> workflows.server -> registerAllWorkflows -> every
 *   template -> every operation handler -> the prompt modules, which read their
 *   markdown from disk. That chain puts a file read on the boot path of the WEB
 *   server, which needs none of it to queue one job, and the read has already
 *   thrown before a server ever listened. Deferring the import to the moment a
 *   job is actually queued cuts the edge.
 *
 *   The `catch` covers the import as well as the call. A dynamic import that
 *   fails to resolve must land on `unavailable` like any other missing
 *   orchestrator, because escaping here would turn a queue problem into a 500 on
 *   a page that is already useful without a generated translation.
 */
async function readOrchestrator(): Promise<WorkflowOrchestrator | null> {
  try {
    const { getOrchestrator } = await import('#app/services/workflows.server');
    return getOrchestrator();
  } catch (cause) {
    log.warn('Translation not queued: the workflow orchestrator is not initialised', {
      reason: cause instanceof Error ? cause.message : String(cause),
    });
    return null;
  }
}

/**
 * What a loader calls.
 *
 * It never awaits the provider and it never rejects. The search page renders the
 * entries it already has and the job it just asked for arrives later, so making
 * the render wait on a queue round trip would trade the whole benefit away.
 *
 * THE RETURN VALUE IS GENUINELY NOT NEEDED HERE, and that is worth stating
 * because discarding an outcome union is a defect shape this repo has already
 * paid for once. Nothing downstream of a background enqueue takes a decision on
 * the outcome: the pane polls `latestRun`, which reports the truth whichever
 * branch was taken. A caller that DOES need to branch calls `enqueueTranslation`
 * and awaits it.
 */
export function enqueueTranslationInBackground(db: DictionaryDb, request: TranslationEnqueueRequest): void {
  void enqueueTranslation(db, request).catch((cause: unknown) => {
    log.error('Background translation enqueue rejected', {
      headwordId: request.headwordId,
      reason: cause instanceof Error ? cause.message : String(cause),
    });
  });
}
