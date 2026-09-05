/**
 * What a queued translation job is allowed to say.
 *
 * THIS SCHEMA IS THE PRIVACY BOUNDARY, AND IT IS THE MOST IMPORTANT THING IN
 * THIS DIRECTORY.
 *   A queued job carries a headword, a language pair and the id of the run row
 *   it reports into, and NOTHING about who asked for it. This product's claim is
 *   that looking a word up does not build a record of the person looking it up,
 *   and a queue row pairing an account with a searched word would defeat that
 *   claim on its own, whatever the rest of the app does.
 *
 *   `z.strictObject` is what makes the absence of an identity field ENFORCEABLE
 *   rather than a convention somebody remembers. An extra key is a parse error, so a future
 *   caller that helpfully threads a user id through gets a rejected enqueue at
 *   the boundary instead of a silently carried field in a JSONB column that
 *   nobody reads again until it matters.
 *
 *   `runId` is not an exception to that rule. It names a `translation_runs` row,
 *   which carries a headword, a direction, a model and a status, and carries no
 *   reader either.
 *
 * WHY THIS IS ITS OWN MODULE, RATHER THAN LIVING IN `enqueue.server`
 *   Two reasons, and both are load-bearing. `#app/workflows/types` needs this
 *   shape for the workflow's context, and `enqueue.server` needs
 *   `WORKFLOW_TYPES` from that module: defining the shape on either of those two
 *   sides makes an evaluation cycle, and the loser of a cycle reads a still
 *   uninitialised binding and throws at module load. And `enqueue.server`
 *   reaches the orchestrator, and through it the database pool, which connects
 *   at import, while the unit tier runs with no database.
 *
 * NO SERVER IMPORTS BELONG HERE.
 */

import { z } from 'zod';

import { SERVED_LANGUAGES } from '#app/lib/dictionary/detect-language';

/** The one shape a queued translation job may carry. See the file comment. */
export const translationJobPayloadSchema = z.strictObject({
  headwordId: z.string().min(1),
  from: z.enum(SERVED_LANGUAGES),
  to: z.enum(SERVED_LANGUAGES),
  promptVersion: z.number().int().positive(),
  /**
   * The `translation_runs` row this job reports into.
   *
   * WRITTEN BEFORE THE ENQUEUE, IN THE REQUEST THAT ASKED. The pane reads the
   * latest run for a key to decide what to show, so a job with no row behind it
   * would leave a reader on "no entry" while a model was already answering. The
   * job's every exit path writes a terminal status onto this id.
   */
  runId: z.string().min(1),
});

export type TranslationJobPayload = z.infer<typeof translationJobPayloadSchema>;

/**
 * The key two identical requests collide on.
 *
 * `runId` IS DELIBERATELY ABSENT. Every other field changes the answer, so every
 * other field is in the key: a different direction is a different translation,
 * and a different prompt version is a different question. The run id is fresh on
 * every request by construction, so including it would make every key unique and
 * the dedupe could never fire once. The whole point of the key is that a second
 * reader asking the same question rides the first reader's job.
 */
export function translationSingletonKey(payload: TranslationJobPayload): string {
  return `${payload.headwordId}:${payload.from}:${payload.to}:${payload.promptVersion}`;
}
