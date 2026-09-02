/**
 * Putting one headword on the enrichment queue.
 *
 * THE PAYLOAD IS THE PRIVACY BOUNDARY. THIS IS THE MOST IMPORTANT THING HERE.
 *   A queued job carries a headword and a language pair, and NOTHING about who
 *   asked for it. This product's claim is that looking a word up does not build
 *   a record of the person looking it up, and a queue row pairing an account
 *   with a searched word would defeat that claim on its own, whatever the rest
 *   of the app does.
 *
 *   `z.strictObject` is what makes "no accountId" ENFORCEABLE rather than a
 *   convention somebody remembers. An extra key is a parse error, so a future
 *   caller that helpfully threads a user id through gets a rejected enqueue at
 *   the boundary instead of a silently carried field in a JSONB column. The
 *   shape itself is written in `#app/lib/enrichment/job-payload`, which states
 *   the rule in full and carries no server import, so the unit tier can hold it
 *   to that rule with no database in front of it.
 *
 * A PAGE MUST NEVER 500 BECAUSE THE QUEUE IS DOWN. Enrichment is an enhancement
 * of an entry page that is already complete without it, so every failure mode
 * here is a return value, not a throw: a duplicate is `deduped`, an
 * uninitialised orchestrator is `unavailable`.
 */

import type { WorkflowOrchestrator } from '@sprqvntrs/workflows';
import { WorkflowError } from '@sprqvntrs/workflows';

import {
  enrichmentJobPayloadSchema,
  enrichmentSingletonKey,
  type EnrichmentJobPayload,
} from '#app/lib/enrichment/job-payload';
import { createComponentLogger } from '#app/lib/logger';
import { WORKFLOW_TYPES } from '#app/workflows/types';

const log = createComponentLogger('EnrichmentEnqueue');

// The payload rules live in a module with no server imports, so the unit tier
// can test them without a database. They are re-exported here because this is
// the contract's public face: a caller enqueues, and never thinks about where
// the schema is written.
export {
  enrichmentJobPayloadSchema,
  enrichmentSingletonKey,
  type EnrichmentJobPayload,
} from '#app/lib/enrichment/job-payload';

/**
 * What an enqueue did.
 *
 * `deduped` is a SUCCESS: the work is already queued or running, which is
 * exactly what the singleton key exists to arrange.
 */
export type EnqueueOutcome = 'queued' | 'deduped' | 'unavailable';

/**
 * Queue one enrichment job, at most once per key.
 *
 * @param payload The headword, the direction, and the prompt version. Parsed
 *   again here even when the caller has a typed value, because this is where the
 *   privacy rule is enforced and a compile-time type does not enforce it against
 *   a value that arrived over HTTP.
 * @returns which of the three things happened. It does not throw for a duplicate
 *   or for a missing orchestrator.
 */
export async function enqueueEnrichment(payload: EnrichmentJobPayload): Promise<EnqueueOutcome> {
  const parsed = enrichmentJobPayloadSchema.parse(payload);
  const singletonKey = enrichmentSingletonKey(parsed);

  const orchestrator = await readOrchestrator();
  if (orchestrator === null) return 'unavailable';

  try {
    await orchestrator.start({
      type: WORKFLOW_TYPES.ENRICH_HEADWORD,
      context: parsed,
      singletonKey,
    });
    return 'queued';
  } catch (cause) {
    // pg-boss returns null from `send` when a job with this singleton key is
    // already queued or active, and @sprqvntrs/workflows 0.2.5 turns that null
    // into a WorkflowError with code QUEUE_ERROR. That is the dedupe working,
    // so it is caught here rather than propagated. The match is on `code`
    // rather than on the message text, which is prose and may be reworded.
    //
    // THE WART THIS PAPERS OVER: `start()` creates the workflow row BEFORE it
    // sends the job, so a deduped enqueue leaves a workflow row behind with no
    // job id under it. That row is inert, nothing polls it, but anyone counting
    // rows in `workflows` should know they are not counting jobs.
    if (cause instanceof WorkflowError && cause.code === 'QUEUE_ERROR') {
      log.debug('Enrichment already queued for this key', { singletonKey });
      return 'deduped';
    }
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
 *   template -> every operation handler -> the enrichment prompt module, which
 *   reads its markdown from disk. That chain put a file read on the boot path of
 *   the WEB server, which needs none of it to queue one job, and the read threw
 *   before the server ever listened. Deferring the import to the moment a job is
 *   actually queued cuts the edge, so the route bundle carries the queue call and
 *   nothing behind it.
 *
 *   The `catch` covers the import as well as the call. A dynamic import that
 *   fails to resolve must land on `unavailable` like any other missing
 *   orchestrator, because escaping here would turn a queue problem into a 500 on
 *   a page that is already complete without enrichment.
 */
async function readOrchestrator(): Promise<WorkflowOrchestrator | null> {
  try {
    const { getOrchestrator } = await import('#app/services/workflows.server');
    return getOrchestrator();
  } catch (cause) {
    log.warn('Enrichment not queued: the workflow orchestrator is not initialised', {
      reason: cause instanceof Error ? cause.message : String(cause),
    });
    return null;
  }
}

/**
 * What a loader calls.
 *
 * It never awaits the provider and it never rejects. A page renders the notes it
 * already has and the job it just asked for arrives later, so making the render
 * wait on a queue round trip would trade the whole benefit away.
 */
export function enqueueEnrichmentInBackground(payload: EnrichmentJobPayload): void {
  void enqueueEnrichment(payload).catch((cause: unknown) => {
    log.error('Background enrichment enqueue rejected', {
      headwordId: payload.headwordId,
      reason: cause instanceof Error ? cause.message : String(cause),
    });
  });
}
