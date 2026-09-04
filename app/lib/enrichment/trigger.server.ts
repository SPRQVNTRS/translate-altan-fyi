/**
 * The enrichment panel a SCREEN shows: the cache resolved, then the decision
 * about whether to start work, folded into one answer.
 *
 * WHY THIS MODULE EXISTS AT ALL, AND WHY IT IS NOT A SECOND COPY.
 *   Two surfaces now render the same four states. The entry page at
 *   `/entry/:headwordId` has rendered them since M171, and the search screen's
 *   output pane renders the top hit's panel inline since M185/03. The logic
 *   below used to live inline in `app/routes/entry.$headwordId.tsx`, which was
 *   fine while there was exactly one caller and is not fine now: the rules here
 *   are subtle enough that a second copy would diverge, quietly, in whichever
 *   surface was edited second. A reader would then get skeletons on one screen
 *   and a refusal line on the other for the same word in the same second.
 *
 *   REJECTED: a shared React hook instead of a shared server function. The
 *   decision needs the request (the rate limiter reads its cookie and its
 *   address) and the database, so it belongs on the server; a hook would have
 *   to fetch it back over the wire and every screen would pay a round trip for
 *   an answer its own loader already had in hand.
 *
 *   REJECTED: folding this into `resolveEnrichmentPanel` in `state.server.ts`.
 *   That resolver is ALSO called by the polling route every three seconds, and
 *   a resolver that enqueues would queue a fresh job on every poll. The split
 *   is deliberate and is documented at the top of that file. This module is the
 *   half that may enqueue; that one never does.
 *
 * WHAT IS NOT HERE: the panel's shape, its states, and the cache read. Those
 * stay in `state.server.ts`, which holds no request and starts no work.
 */

import { isBudgetExhausted } from '#app/lib/abuse/budget.server';
import { checkTriggerRateLimit } from '#app/lib/abuse/rate-limit.server';
import type { LanguageCode } from '#app/lib/dictionary/detect-language';
import type { DictionaryDb } from '#app/lib/dictionary/queries.server';
import { enqueueEnrichmentInBackground } from '#app/lib/enrichment/enqueue.server';
import {
  resolveEnrichmentPanel,
  type EnrichmentPanel,
  type EnrichmentRefusal,
} from '#app/lib/enrichment/state.server';
import { PROMPT_VERSION } from '#app/prompts/enrichment/version';

// The panel type travels with the function that produces it, so a route can
// name the shape it renders without reaching past this module into the
// resolver. It is a TYPE re-export and is erased before any bundle is built.
export type { EnrichmentPanel } from '#app/lib/enrichment/state.server';

/**
 * The panel for a screen that shows no entry at all, and for an entry in a
 * language this dictionary does not serve. Nothing is arriving in either case,
 * and nobody asked for it, which is exactly what `not-requested` says.
 *
 * IT IS NOT THE SAME SENTENCE AS `not-configured`, AND THAT MATTERS.
 *   `EnrichmentSection` renders `enrichment.idle` for this reason and
 *   `enrichment.notConfigured` for the other one. Collapsing them would make a
 *   server with a perfectly healthy provider key read exactly like a server
 *   with no key at all, which is a thing that has already cost a debugging
 *   session on this code. Any new surface rendering these states must go
 *   through that component rather than write its own idle line.
 */
export const MISSING_ENTRY_PANEL: EnrichmentPanel = {
  state: 'idle',
  reason: 'not-requested',
  model: null,
  from: null,
  senses: [],
};

export interface ResolveTriggeredPanelParams {
  db: DictionaryDb;
  /** The screen's own request. The guards read its cookie and its address. */
  request: Request;
  headwordId: string;
  /** The sense ids the screen renders, in page order. */
  senseIds: string[];
  /**
   * The entry's own language, or `null` when it is outside the served four.
   *
   * `null` short-circuits to `MISSING_ENTRY_PANEL`: both the cache key and the
   * job payload are keyed on a served language, so an entry outside them would
   * write a row nothing could ever look up again.
   */
  from: LanguageCode | null;
  to: LanguageCode;
  /** The reader, for "my vote" on each cached row. `null` for an anonymous visitor. */
  accountId?: number | null;
}

/**
 * Read the cache, then start the work if starting it is the right move.
 *
 * This is the ONE function a loader calls. Both halves in one place is what
 * keeps "resolved but never triggered" from being a state a caller can reach by
 * forgetting a line.
 *
 * @returns the panel to render. It never throws: a screen whose dictionary rows
 *   are already in hand must not 500 because a guard or a queue had an opinion.
 */
export async function resolveTriggeredPanel(params: ResolveTriggeredPanelParams): Promise<EnrichmentPanel> {
  const { db, request, headwordId, senseIds, from, to, accountId } = params;
  if (from === null) return MISSING_ENTRY_PANEL;

  const resolved = await resolveEnrichmentPanel(db, { headwordId, senseIds, from, to, accountId });
  return triggerEnrichment(request, resolved, { headwordId, from, to });
}

/**
 * Whether this panel is asking for work, and what happens if it is.
 *
 * A CACHE HIT IS NOT A TRIGGER. IT IS NEVER COUNTED AND NEVER REFUSED.
 *   A `ready` panel already holds every note the screen will show. Nothing will
 *   be queued for it, no provider will be called, and it will cost nothing, so
 *   running it past the rate limiter would count a request that spends no money
 *   against a budget for requests that do. The honest majority of readers, the
 *   ones landing on words the dictionary has already enriched, would then be the
 *   ones who exhaust the limit and get turned away, while the script walking
 *   uncached words gets the same allowance either way. The limiter therefore
 *   sees ONLY the panels that would start real work.
 *
 * THE GUARDS ARE AWAITED, NOT FIRED BEHIND THE RESPONSE.
 *   The enqueue is fire and forget on purpose, because its answer changes
 *   nothing on the screen. These two do the opposite: their whole job is to
 *   decide whether the enqueue happens at all, and a decision taken after the
 *   response has gone is not a decision.
 *
 * @returns the panel to render. A refusal returns the SAME panel with one field
 *   set: the entry beside it is complete, the HTTP status is unchanged, and
 *   nothing throws.
 */
async function triggerEnrichment(
  request: Request,
  panel: EnrichmentPanel,
  key: { headwordId: string; from: LanguageCode; to: LanguageCode },
): Promise<EnrichmentPanel> {
  // An idle panel has nothing to ask for and a READY one is the cache hit above.
  if (panel.state === 'idle' || panel.state === 'ready') return panel;
  // A failed panel is retried only once its window has passed. Without that
  // check one provider outage pins the entry to "failed" forever, because the
  // loader would never queue for it again.
  if (panel.state === 'failed' && !panel.retryable) return panel;

  const working = { reason: null, model: panel.model, from: panel.from, senses: panel.senses };

  const refusal = await refuseTrigger(request);
  if (refusal !== null) {
    // A REFUSAL LEAVES THE STATE ALONE. Nothing was started, so a failed panel
    // is still failed and a pending one is still pending; the only new fact is
    // WHY no work is running, which is one line of copy inside one card.
    if (panel.state === 'failed') {
      return { ...working, state: 'failed', retryable: panel.retryable, refusal };
    }
    return { ...working, state: 'pending', refusal };
  }

  // FIRE AND FORGET. A loader NEVER awaits a provider: the dictionary rows are
  // already in hand, and holding the page open for a model call would trade a
  // fast screen for a slow one on every first visit. The job runs behind the
  // response, and the panel polls the read-only companion route for its result.
  //
  // THIS IS THE TERMINAL PATH DESIGN.md RULE 3 DEMANDS. The pending panel
  // returned below is not a skeleton with no exit: a job is genuinely running,
  // it writes ok or failed rows either way, and `EnrichmentSection` polls
  // `/api/enrichment/:headwordId` until the same resolver reports `ready` or
  // `failed`. `tests/integration/inline-enrichment-panel-resolves.test.ts`
  // drives that chain end to end rather than trusting this comment.
  enqueueEnrichmentInBackground({
    headwordId: key.headwordId,
    from: key.from,
    to: key.to,
    promptVersion: PROMPT_VERSION,
  });

  // PENDING, EVEN WHEN THE PANEL WAS FAILED. The screen must show the run it
  // just started, not the failure it is retrying past, or the reader would be
  // told the notes cannot be generated while a job to generate them is in
  // flight.
  return { ...working, state: 'pending', refusal: null };
}

/**
 * Which guard turns this trigger away, or `null` when neither does.
 *
 * The rate limit runs first, because it is the cheaper question and it is the
 * one that describes THIS caller. The budget is an installation-wide fact, so
 * asking it first would let one visitor's flood be reported as everyone's cap.
 */
async function refuseTrigger(request: Request): Promise<EnrichmentRefusal | null> {
  const verdict = await checkTriggerRateLimit(request);
  if (!verdict.allowed) return 'rate-limited';
  if (await isBudgetExhausted()) return 'budget';
  return null;
}
