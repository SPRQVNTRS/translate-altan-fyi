/**
 * Which of the four enrichment states an entry page is in, and the rows that
 * go with it.
 *
 * THIS MODULE NEVER ENQUEUES, AND THAT IS THE REASON IT EXISTS.
 *   Two callers need the same answer: the entry loader, which renders the page
 *   and DOES want a job queued when nothing is cached yet, and the polling
 *   route, which is asked the same question every three seconds while that job
 *   runs. Folding the enqueue into the resolver would make every poll queue
 *   another job for work already in flight, so a reader who waits a minute
 *   would pay for twenty runs of one enrichment. The enqueue is therefore the
 *   caller's decision, taken once, in the loader.
 *
 * THE DATABASE IS A PARAMETER, NEVER AN IMPORT.
 *   The same rule the dictionary queries and the enrichment model follow. Only
 *   the TYPE is imported, so importing this file opens no connection pool.
 */

import { ENRICHMENT_RETRY_AFTER_MS, ENRICHMENT_SENSE_LIMIT } from '#app/lib/enrichment/limits';
import type { LanguageCode } from '#app/lib/dictionary/detect-language';
import type { DictionaryDb } from '#app/lib/dictionary/queries.server';
import { registry } from '#app/lib/llm/registry.server';
import { getActiveModel } from '#app/models/app-settings.server';
import {
  latestAttempt,
  listCachedEnrichments,
  type EnrichmentCacheKey,
  type EnrichmentView,
} from '#app/models/enrichments.server';
import { readVotesForAccount, tallyVotes } from '#app/models/votes.server';
import { PROMPT_VERSION } from '#app/prompts/enrichment/version';

/** The four states of the generated explanation and extra examples. */
export type EnrichmentState = 'idle' | 'pending' | 'ready' | 'failed';

/**
 * Why a panel is idle.
 *
 * The two cases read identically on the server, an empty result set, and must
 * NOT read identically to the reader. `not-configured` means this server holds
 * no key for the active provider, so the notes can never arrive and saying
 * "once this entry is enriched" would be a promise nobody can keep.
 * `not-requested` means the work simply has not been asked for yet.
 */
export type EnrichmentIdleReason = 'not-configured' | 'not-requested';

/**
 * One cached row as a panel renders it, with the reader's view of its score.
 *
 * `EnrichmentView` minus `createdAt`. The panel crosses the wire as JSON on the
 * polling route, and a `Date` does not survive that trip; it arrives as a
 * string. Dropping the one field no surface renders keeps the type true on both
 * sides, instead of declaring a `Date` the browser would never receive.
 *
 * `id` is renamed to `enrichmentId` on the way out, because on this side of the
 * boundary it sits next to a `senseId` and a bare `id` would read as either.
 */
export interface EnrichmentPanelSense extends Omit<EnrichmentView, 'createdAt' | 'id'> {
  /** The row a vote attaches to. A vote judges one cached ANSWER, not a sense. */
  enrichmentId: string;
  /** How many readers found these notes helpful. */
  up: number;
  /** How many did not. */
  down: number;
  /**
   * This reader's own vote, or `null` for no vote and for no account.
   *
   * The two cases are the same on screen, and deliberately so: a reader with no
   * account has cast no vote, so there is nothing to show them as cast. There is
   * no neutral vote, because not voting IS the neutral case.
   */
  myVote: -1 | 1 | null;
}

/** Nothing is shown, and the reason is part of the answer. */
export interface EnrichmentPanelIdle {
  state: 'idle';
  reason: EnrichmentIdleReason;
  /** The active model, or `null` when the entry has no sense to enrich at all. */
  model: string | null;
  /** The entry's own language, or `null` when the id names no servable entry. */
  from: LanguageCode | null;
  senses: EnrichmentPanelSense[];
}

/**
 * What a pending and a ready panel share.
 *
 * Work is either running or done, so the model that will produce, or did
 * produce, the rows is known. It is a plain `string` here rather than a
 * nullable one, because the attribution line under a ready panel is a legal
 * requirement and must never render a blank model name.
 */
interface EnrichmentPanelWorking {
  reason: null;
  model: string;
  /**
   * The entry's own language. The notes are written in the target language, but
   * the example sentences are in this one, and a screen reader needs both codes
   * to switch voice correctly, DESIGN.md section 4.
   */
  from: LanguageCode;
  senses: EnrichmentPanelSense[];
}

/**
 * Why a panel is showing no new work, when the reason is a spend guard rather
 * than a fault.
 *
 * A REFUSAL IS NOT AN ERROR PAGE. The dictionary entry above the panel is
 * complete and stays on screen; the only thing missing is the generated notes,
 * which the entry never needed to be useful. So a refusal changes one line of
 * copy inside one card, and it changes no HTTP status, throws nothing, and takes
 * nothing off the page.
 */
export type EnrichmentRefusal = 'rate-limited' | 'budget';

/** A job is running, so some senses may already be cached and some may not. */
export interface EnrichmentPanelPending extends EnrichmentPanelWorking {
  state: 'pending';
  /**
   * Set by the LOADER, never by this resolver, and `null` in every other caller.
   *
   * It rides on the existing members rather than becoming a fifth state, because
   * a fifth state would be a fifth code path through the component for something
   * that is one sentence of copy. The resolver cannot compute it: it holds no
   * request and knows nothing about the guards.
   */
  refusal: EnrichmentRefusal | null;
}

/** Every sense the page renders has a cached row. */
export interface EnrichmentPanelReady extends EnrichmentPanelWorking {
  state: 'ready';
}

/**
 * The last attempt failed, and nothing is running to replace it.
 *
 * It extends the working shape rather than the idle one because a failure is
 * not an absence: a specific model was asked, under a specific prompt version,
 * and answered badly. The model name is therefore known, which is what lets a
 * partially filled failed panel still carry its attribution line.
 */
export interface EnrichmentPanelFailed extends EnrichmentPanelWorking {
  state: 'failed';
  /**
   * Whether the failure is old enough for the page to ask again.
   *
   * THE LOOP BREAKER. The loader only queues for a `pending` panel, so a failed
   * key is never re-queued and one ten-minute provider outage would otherwise
   * pin every entry it touched to "could not be generated" forever. `false` here
   * means the failure is recent and the page must leave it alone; `true` means
   * the window in `ENRICHMENT_RETRY_AFTER_MS` has passed and one more attempt is
   * worth its cost.
   */
  retryable: boolean;
  /** See `EnrichmentPanelPending.refusal`. Set by the loader, `null` everywhere else. */
  refusal: EnrichmentRefusal | null;
}

/**
 * What the entry page and the polling route both answer with.
 *
 * A union rather than one flat object, so `state: 'ready'` and a missing model
 * cannot be expressed at the same time. One member per state, with one literal
 * `state` each: a member carrying `'pending' | 'ready'` narrows its own
 * property but is never removed from the union, so a consumer that has returned
 * for both would still see it in the remainder.
 */
export type EnrichmentPanel =
  EnrichmentPanelIdle | EnrichmentPanelPending | EnrichmentPanelReady | EnrichmentPanelFailed;

export interface ResolveEnrichmentPanelParams {
  headwordId: string;
  /** The sense ids the page renders, in page order. */
  senseIds: string[];
  from: LanguageCode;
  to: LanguageCode;
  /**
   * Whether a job for this key is known to be in flight.
   *
   * THE RESOLVER NEVER READS pg-boss, AND THAT IS WHY THIS IS A PARAMETER.
   *   This module holds no queue handle by design, for the same reason it never
   *   enqueues: it is shared by the entry loader and by a poll that runs every
   *   three seconds, and a queue read on that path would be a second source of
   *   truth about work neither caller owns. A caller that HAS just queued a
   *   job, or that can see one running, says so here; a caller that cannot know
   *   omits it and gets the safe reading, that nothing is running.
   *
   * Defaults to `false`, so the two existing callers keep their behaviour.
   */
  jobQueued?: boolean;
  /**
   * Whose votes to mark as "mine", when there is a reader to mark them for.
   *
   * OMITTED MEANS NO PER-ACCOUNT READ IS ISSUED AT ALL, not a read that returns
   * nothing. The default mode of this product is anonymous, so most callers pass
   * nothing here, and every `myVote` is `null` without the database being asked
   * a question whose answer was known in advance.
   */
  accountId?: string | null;
}

/** The cached rows for `target`, in `target`'s order, with uncached senses left out. */
function orderByTarget(rows: EnrichmentView[], target: string[]): EnrichmentView[] {
  const bySense = new Map<string, EnrichmentView>();
  for (const row of rows) {
    // The rows arrive newest first, so the first one seen for a sense is the
    // one to keep.
    if (!bySense.has(row.senseId)) bySense.set(row.senseId, row);
  }

  const ordered: EnrichmentView[] = [];
  for (const senseId of target) {
    const row = bySense.get(senseId);
    if (!row) continue;
    ordered.push(row);
  }
  return ordered;
}

/**
 * Attach each row's score, and this reader's own vote when there is a reader.
 *
 * TWO READS AT MOST, AND THE SECOND ONE IS SKIPPED FOR AN ANONYMOUS VISITOR.
 *   The tallies are a property of the shared answer, so they are read for
 *   everyone. "Which of these did I vote on" is a property of one account, so it
 *   is read only when an account was passed. Asking for it with no account would
 *   be a query whose result is known to be empty.
 *
 * A row with no votes is a zero, never a missing entry: the panel renders a
 * count, and an absent tally and a tally of zero are the same fact.
 */
async function withVotes(
  db: DictionaryDb,
  rows: EnrichmentView[],
  accountId: string | null | undefined,
): Promise<EnrichmentPanelSense[]> {
  if (rows.length === 0) return [];

  const enrichmentIds = rows.map((row) => row.id);

  // ONE TALLY QUERY PER ROW, BOUNDED BY `ENRICHMENT_SENSE_LIMIT`.
  //   `tallyVotes` counts one enrichment, so this is six reads at the very most
  //   and usually fewer, issued together rather than in sequence. It is still an
  //   N+1 and it is named as one: the right fix is a bulk tally in
  //   `app/models/votes.server.ts` keyed on `inArray`, and this loop should be
  //   replaced by it rather than grown.
  const tallies = await Promise.all(rows.map((row) => tallyVotes(db, row.id)));

  const mine =
    accountId === null || accountId === undefined
      ? new Map<string, -1 | 1>()
      : await readVotesForAccount(db, { accountId, enrichmentIds });

  return rows.map((row, index) => {
    const tally = tallies[index];
    return {
      enrichmentId: row.id,
      senseId: row.senseId,
      provider: row.provider,
      model: row.model,
      promptVersion: row.promptVersion,
      output: row.output,
      up: tally?.up ?? 0,
      down: tally?.down ?? 0,
      myVote: mine.get(row.id) ?? null,
    };
  });
}

/**
 * Read the cache and decide what the entry page should show.
 *
 * A CACHED ROW IS SHOWN EVEN WHEN THE KEY HAS SINCE DISAPPEARED.
 *   This is the one case where `ready` and "the provider is not configured"
 *   coexist, and it is deliberate. The text was paid for and stored, so pulling
 *   it off the page because an environment variable was rotated away would
 *   destroy value for no reader's benefit. The configuration check therefore
 *   runs only on the path where something still has to be generated.
 *
 * @param db The dictionary database handle.
 * @param params The headword, the senses the page renders, the direction, and
 *   whether the caller already knows a job is in flight.
 * @returns The state, the model behind it, and the cached rows in page order.
 */
export async function resolveEnrichmentPanel(
  db: DictionaryDb,
  params: ResolveEnrichmentPanelParams,
): Promise<EnrichmentPanel> {
  const target = params.senseIds.slice(0, ENRICHMENT_SENSE_LIMIT);
  if (target.length === 0) {
    return { state: 'idle', reason: 'not-requested', model: null, from: params.from, senses: [] };
  }

  const active = await getActiveModel();
  const cacheKey = {
    headwordId: params.headwordId,
    from: params.from,
    to: params.to,
    model: active.model,
    promptVersion: PROMPT_VERSION,
  } satisfies EnrichmentCacheKey;
  const rows = await listCachedEnrichments(db, cacheKey);
  const ordered = orderByTarget(rows, target);
  const senses = await withVotes(db, ordered, params.accountId);

  if (senses.length === target.length) {
    return { state: 'ready', reason: null, model: active.model, from: params.from, senses };
  }

  // A server with no key can never finish, and skeletons that never resolve are
  // a lie, DESIGN.md rule 3. So the honest answer here is idle with a reason,
  // not a pending panel nobody will ever see complete.
  if (!registry.describeConfiguration(active).configured) {
    return { state: 'idle', reason: 'not-configured', model: active.model, from: params.from, senses: [] };
  }

  // A key whose newest row is a failure, with nothing queued, is NOT pending.
  // Returning pending here is the lie rule 3 forbids: the page would show
  // skeletons for a minute and then say the work is slow, when no work exists.
  //
  // PARTIAL SUCCESS IS STILL CARRIED. `senses` goes out with the failure rather
  // than being blanked, because a run that enriched two senses of three was
  // paid for, and the reader keeps the notes that landed. The panel says the
  // explanation could not be generated AND shows what did.
  const latest = params.jobQueued === true ? null : await latestAttempt(db, cacheKey);
  if (latest !== null && latest.failed) {
    // THE RETRY WINDOW IS COMPUTED HERE AND ENFORCED BY THE CALLER. This module
    // never enqueues, so it states the fact, "this failure is old enough to try
    // again", and the loader decides what to do with it. Computing it here is
    // what keeps the one hour figure in one place: the poll route and the loader
    // read the same panel and can never disagree about whether a key is
    // retryable.
    const retryable = Date.now() - latest.at.getTime() >= ENRICHMENT_RETRY_AFTER_MS;
    return { state: 'failed', reason: null, model: active.model, from: params.from, senses, retryable, refusal: null };
  }

  return { state: 'pending', reason: null, model: active.model, from: params.from, senses, refusal: null };
}
