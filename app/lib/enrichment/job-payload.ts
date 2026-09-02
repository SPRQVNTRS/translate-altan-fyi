/**
 * What a queued enrichment job is allowed to say.
 *
 * THIS SCHEMA IS THE PRIVACY BOUNDARY, AND IT IS THE MOST IMPORTANT THING IN
 * THIS DIRECTORY.
 *   A queued job carries a headword and a language pair, and NOTHING about who
 *   asked for it. This product's claim is that looking a word up does not build
 *   a record of the person looking it up, and a queue row pairing an account
 *   with a searched word would defeat that claim on its own, whatever the rest
 *   of the app does.
 *
 *   `z.strictObject` is what makes "no accountId" ENFORCEABLE rather than a
 *   convention somebody remembers. An extra key is a parse error, so a future
 *   caller that helpfully threads a user id through gets a rejected enqueue at
 *   the boundary instead of a silently carried field in a JSONB column that
 *   nobody reads again until it matters.
 *
 * WHY THIS IS ITS OWN MODULE, RATHER THAN LIVING IN `enqueue.server`
 *   Two reasons, and both are load-bearing.
 *
 *   `#app/workflows/types` needs this shape for the workflow's context, and
 *   `enqueue.server` needs `WORKFLOW_TYPES` from that module. Defining the shape
 *   on either of those two sides makes an evaluation cycle, and the loser of a
 *   cycle reads a still-uninitialised binding and throws at module load.
 *
 *   `enqueue.server` reaches the orchestrator, and through it the database pool,
 *   which connects at import. The unit tier runs with no database. Keeping the
 *   payload rules here lets them be tested by a unit test rather than by an
 *   integration test that the pre-push gate never runs.
 *
 * NO SERVER IMPORTS BELONG HERE.
 */

import { z } from 'zod';

import { SERVED_LANGUAGES } from '#app/lib/dictionary/detect-language';

/** The one shape a queued enrichment job may carry. See the file comment. */
export const enrichmentJobPayloadSchema = z.strictObject({
  headwordId: z.string().min(1),
  from: z.enum(SERVED_LANGUAGES),
  to: z.enum(SERVED_LANGUAGES),
  promptVersion: z.number().int().positive(),
});

export type EnrichmentJobPayload = z.infer<typeof enrichmentJobPayloadSchema>;

/**
 * The key two identical requests collide on.
 *
 * Every field of the payload is in it, because every field changes the answer: a
 * different direction is different notes, and a different prompt version is a
 * different question. Nothing else belongs in it, for the reason at the top of
 * this file.
 */
export function enrichmentSingletonKey(payload: EnrichmentJobPayload): string {
  return `${payload.headwordId}:${payload.from}:${payload.to}:${payload.promptVersion}`;
}
