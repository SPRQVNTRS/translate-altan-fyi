/**
 * What a queued phrase job is allowed to say.
 *
 * THIS SCHEMA IS THE PRIVACY BOUNDARY, AND IT IS THE MOST IMPORTANT THING IN
 * THIS FILE.
 *   A queued job carries a folded sentence, a language pair and the id of the
 *   row it reports into, and NOTHING about who asked for it. This product's
 *   claim is that translating something does not build a record of the person
 *   who translated it, and a queue row pairing a reader with a sentence would
 *   defeat that claim on its own, whatever the rest of the app does.
 *
 *   `z.strictObject` is what makes the absence of an identity field ENFORCEABLE
 *   rather than a convention somebody remembers. An extra key is a parse error,
 *   so a future caller that helpfully threads a user id through gets a rejected
 *   enqueue at the boundary instead of a silently carried field in a JSONB
 *   column that nobody reads again until it matters.
 *
 *   `runId` is not an exception to that rule. It names a `phrase_translations`
 *   row, which carries a text, a direction, a model and a status, and carries no
 *   reader either.
 *
 * THE TEXT AS TYPED IS NOT IN THE PAYLOAD, AND THAT IS NOT A PRIVACY POINT.
 *   The job reads it from its own row, which already holds it. Carrying it here
 *   too would mean the queue and the row could disagree about what was asked,
 *   and the row is the one a reader is served from.
 *
 * WHY THIS IS ITS OWN MODULE, RATHER THAN LIVING IN `phrase-enqueue.server`
 *   The same two reasons `job-payload.ts` gives. `#app/workflows/types` needs
 *   this shape for the workflow's context and `phrase-enqueue.server` needs
 *   `WORKFLOW_TYPES` from that module, so defining it on either side makes an
 *   evaluation cycle, and the loser of a cycle reads a still uninitialised
 *   binding and throws at module load. And `phrase-enqueue.server` reaches the
 *   orchestrator, and through it the database pool, which connects at import,
 *   while the unit tier runs with no database.
 *
 * NO SERVER IMPORTS BELONG HERE.
 */

import { z } from 'zod';

import { SERVED_LANGUAGES } from '#app/lib/dictionary/detect-language';

/** The one shape a queued phrase job may carry. See the file comment. */
export const phraseJobPayloadSchema = z.strictObject({
  from: z.enum(SERVED_LANGUAGES),
  to: z.enum(SERVED_LANGUAGES),
  /**
   * The folded text, which is the cache key: `normalizeQuery(raw, from).normalized`.
   *
   * It is here because the singleton key is built from it, and two readers
   * typing the same sentence with different capitals have to collide.
   */
  sourceNormalized: z.string().min(1),
  promptVersion: z.number().int().positive(),
  /**
   * The `phrase_translations` row this job reports into.
   *
   * WRITTEN BEFORE THE ENQUEUE, IN THE REQUEST THAT ASKED. The pane reads the
   * latest row for a key to decide what to show, so a job with no row behind it
   * would leave a reader looking at nothing while a model was already answering.
   * The job's every exit path writes a terminal status onto this id.
   */
  runId: z.string().min(1),
});

export type PhraseJobPayload = z.infer<typeof phraseJobPayloadSchema>;

/**
 * The key two identical requests collide on.
 *
 * `runId` IS DELIBERATELY ABSENT, for the reason `translationSingletonKey`
 * gives: it is fresh on every request by construction, so including it would
 * make every key unique and the dedupe could never fire once. The whole point is
 * that a second reader typing the same sentence rides the first reader's job.
 *
 * THE PREFIX IS NOT DECORATION. Phrase jobs share the `translation` queue with
 * the word job, and the queue's dedupe index is over `(name, state,
 * singleton_key)`. Without a namespace, a folded sentence that happened to equal
 * a headword id could collide with a word run and one of the two would silently
 * never be queued.
 */
export function phraseSingletonKey(payload: PhraseJobPayload): string {
  return `phrase:${payload.from}:${payload.to}:${payload.promptVersion}:${payload.sourceNormalized}`;
}
