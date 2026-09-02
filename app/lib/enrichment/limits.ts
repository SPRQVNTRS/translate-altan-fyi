/**
 * The two numbers the enrichment feature is bounded by.
 *
 * NO IMPORTS, AND NONE MAY BE ADDED. The entry page reads these constants while
 * it decides what to wait for, so this module is reached by the client bundle. A
 * `.server` import here, even a type-only one, breaks the production build and
 * nothing earlier catches it.
 */

/**
 * How many senses one job enriches.
 *
 * A REAL PRODUCT DECISION, NOT A GUARD RAIL. This dictionary carries eleven
 * senses for "Schnecke" and twenty two for "Germania". Asking one call to write
 * full study notes for all of them invites a truncated answer, and a truncated
 * answer is worse than a small one: the page can then never reach "every sense
 * is enriched", so it re-queues the same job on every single load.
 *
 * The page therefore enriches the FIRST `ENRICHMENT_SENSE_LIMIT` senses, in the
 * order the entry renders them. The same constant decides what the job writes
 * and what the page waits for, so those two can never disagree.
 */
export const ENRICHMENT_SENSE_LIMIT = 6;

/**
 * Explicit request timeout for the provider call, in milliseconds.
 *
 * WHY THE VALUE IS STATED AT ALL. undici caps any non-streaming fetch at 300
 * seconds, and it surfaces that failure in the `json()` catch rather than the
 * `fetch` catch. A call with no explicit timeout can therefore hang for five
 * minutes and then fail in a place that reads like a parsing bug.
 *
 * 120 seconds is the deliberate ceiling, and a timeout is treated as an ordinary
 * failure: it writes a failed row like any other rejection does.
 */
export const ENRICHMENT_TIMEOUT_MS = 120_000;

/**
 * The pg-boss queue enrichment jobs are sent to.
 *
 * A DEDICATED QUEUE, AND IT HAS TO BE. In pg-boss 10.4.2 the dedupe that a
 * singleton key asks for is a property of the QUEUE's policy, not of the
 * individual send: every unique index over `singleton_key` is gated on the
 * queue's policy, so the key only bites when the queue carries a deduping one.
 * Enrichment therefore cannot live on the shared `default` queue, because
 * setting a policy there would change dedupe semantics for every other workflow
 * that shares it.
 *
 * The constant lives here, beside the other enrichment bounds, so the template
 * and the orchestrator wiring read the SAME name and cannot drift apart.
 */
export const ENRICHMENT_QUEUE = 'enrichment';
