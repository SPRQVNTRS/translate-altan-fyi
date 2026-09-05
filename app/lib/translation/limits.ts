/**
 * The numbers the on-demand translation feature is bounded by.
 *
 * NO IMPORTS, AND NONE MAY BE ADDED. The search pane reads these constants while
 * it decides what to wait for and what to say, so this module is reached by the
 * client bundle. A `.server` import here, even a type-only one, breaks the
 * production build and nothing earlier catches it. The same rule, for the same
 * reason, as `app/lib/enrichment/limits.ts`.
 */

/**
 * The pg-boss queue translation jobs are sent to.
 *
 * A DEDICATED QUEUE, AND IT HAS TO BE. In pg-boss 10.4.2 the dedupe that a
 * singleton key asks for is a property of the QUEUE's policy, not of the
 * individual send: every unique index over `singleton_key` is gated on the
 * queue's policy, so the key only bites when the queue carries a deduping one.
 * Translation therefore cannot live on the shared `default` queue, because
 * setting a policy there would change dedupe semantics for every other workflow
 * that shares it, and it cannot share the `enrichment` queue either: two
 * features on one queue share its worker pool, so a slow enrichment run would
 * hold a reader's translation behind it.
 *
 * `app/services/workflows.server.ts` is the only place that can set the policy,
 * and it sets `stately` here for the reason written out beside the enrichment
 * queue there.
 */
export const TRANSLATION_QUEUE = 'translation';

/**
 * Explicit request timeout for the provider call, in milliseconds.
 *
 * WHY THE VALUE IS STATED AT ALL. undici caps any non-streaming fetch at 300
 * seconds and surfaces that failure in the `json()` catch rather than the
 * `fetch` catch, so a call with no explicit timeout can hang for five minutes
 * and then fail in a place that reads like a parsing bug.
 *
 * 90 seconds, shorter than enrichment's 120, because a reader is WAITING on this
 * one. Enrichment fills in a page that is already complete; a translation run is
 * the answer to the question the reader just asked, and a pane that spins for
 * two minutes has already lost them. A timeout is an ordinary failure: the run
 * ends `failed` and the retry button re-enqueues it.
 */
export const TRANSLATION_TIMEOUT_MS = 90_000;

/**
 * How many senses one run may cover.
 *
 * A PRODUCT DECISION, NOT A GUARD RAIL, and the same one enrichment makes at
 * `ENRICHMENT_SENSE_LIMIT`. A headword with twenty two senses asked for in one
 * call invites a truncated answer, and a truncated answer costs money and
 * teaches the reader nothing. Six is what a reader can hold at once.
 *
 * The cap lives in the answer schema as well, so a model that returns more than
 * six senses fails the parse rather than being silently trimmed: a silent trim
 * would let the run report `ok` while the reader is looking at a different set
 * of senses than the one that was paid for.
 */
export const MAX_SENSES = 6;

/**
 * How many translations one sense may carry back.
 *
 * Best first, at most five, the same figure the enrichment answer uses. A list
 * longer than that stops being an answer and becomes a thesaurus, and every
 * extra entry is a `translations` row and a target headword this installation
 * then owns forever.
 */
export const MAX_TRANSLATIONS_PER_SENSE = 5;

/**
 * How many translation runs this installation will start in one UTC day.
 *
 * A SECOND CAP BESIDE THE MONEY, AND IT IS NOT REDUNDANT. `DAILY_BUDGET_USD`
 * bounds the spend, and it bounds it against an ESTIMATE. A model priced at a
 * fraction of a cent per call reaches this number long before it reaches three
 * dollars, and every run past it writes permanent rows into the shared
 * dictionary. This cap bounds the CORPUS, not the bill: it is the answer to "a
 * script found the search box", where the money cap alone would let thousands of
 * unreviewed generated senses land before anyone noticed.
 *
 * Counted from `translation_runs`, over rows that are `pending` or `ok`, so a
 * failed run does not spend the day's allowance. Two hundred is a figure with
 * headroom for a real day's reading and none for a crawler.
 */
export const MAX_TRANSLATION_RUNS_PER_DAY = 200;

/**
 * The longest piece of running text this installation will translate, in
 * characters, measured on the text as typed.
 *
 * IT IS A REFUSAL, NEVER A TRUNCATION, and that is the whole reason the number
 * lives here rather than inside a `slice`. Cutting a sentence at 200 characters
 * would send the model a sentence the reader did not type, and present what
 * came back as the answer to the one they did. A reader cannot see that; they
 * would read a confident half-answer and trust it. So the guard refuses, says
 * so, and leaves the box alone.
 *
 * TWO HUNDRED, because it is the length of a long ordinary sentence and a
 * fraction of a paragraph. It is also the first guard the trigger asks, since
 * it costs nothing and cannot be wrong: it needs no query, no clock and no
 * shared counter.
 *
 * IT IS NOT `PHRASE_TOKEN_LIMIT`. That constant caps how many words the
 * DICTIONARY lookup will match a phrase against, which is a different question
 * about a different feature, and neither one bounds the other.
 */
export const PHRASE_MAX_CHARS = 200;

/**
 * How many phrase runs this installation will start in one UTC day.
 *
 * A SECOND CAP BESIDE THE MONEY, counted separately from the word one because
 * the two bound different things. `MAX_TRANSLATION_RUNS_PER_DAY` bounds how much
 * generated content lands in the shared dictionary; nothing a phrase run writes
 * reaches the dictionary at all, so this cap bounds the CALLS: it is the answer
 * to "a script found the search box and is pasting paragraphs into it", where
 * the money cap alone leaves a cheap model thousands of calls before anyone
 * notices.
 *
 * Counted from `phrase_translations`, over rows that are `pending` or `ok`, so a
 * failed or refused run does not spend the day's allowance.
 */
export const MAX_PHRASE_RUNS_PER_DAY = 200;
