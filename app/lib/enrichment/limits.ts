/**
 * The numbers the enrichment feature is bounded by.
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

/**
 * How long a failed enrichment stays failed before the entry page may ask again.
 *
 * THE LOOP THIS CLOSES, AND IT IS A LOOP THAT NEVER ENDS ON ITS OWN.
 *   The entry loader only ever queues a job for a `pending` panel. A key whose
 *   newest row is a failure resolves to `failed`, so it is never queued again,
 *   and the failure is permanent. That is the right answer for a model that
 *   cannot write these notes at all, and the wrong answer for the far more
 *   common case: a provider that was down for ten minutes. Without this window,
 *   one transient outage pins every entry it touched to "could not be generated"
 *   for the life of the deployment, and only a prompt-version bump or a model
 *   switch, both of which change the cache key, would ever release them.
 *
 *   An hour is the deliberate figure. Long enough that a provider having a bad
 *   afternoon is not re-asked by every reader who lands on the page, short
 *   enough that a reader coming back the same day sees the entry recover.
 */
export const ENRICHMENT_RETRY_AFTER_MS = 3_600_000;
