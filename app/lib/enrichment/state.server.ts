/**
 * Which of the three enrichment states an entry page is in, and the rows that
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

import { ENRICHMENT_SENSE_LIMIT } from '#app/lib/enrichment/limits';
import type { LanguageCode } from '#app/lib/dictionary/detect-language';
import type { DictionaryDb } from '#app/lib/dictionary/queries.server';
import { registry } from '#app/lib/llm/registry.server';
import { getActiveModel } from '#app/models/app-settings.server';
import { listCachedEnrichments, type EnrichmentView } from '#app/models/enrichments.server';
import { PROMPT_VERSION } from '#app/prompts/enrichment/version';

/** The three states of the generated explanation and extra examples. */
export type EnrichmentState = 'idle' | 'pending' | 'ready';

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
 * One cached row as a panel renders it.
 *
 * `EnrichmentView` minus `createdAt`. The panel crosses the wire as JSON on the
 * polling route, and a `Date` does not survive that trip; it arrives as a
 * string. Dropping the one field no surface renders keeps the type true on both
 * sides, instead of declaring a `Date` the browser would never receive.
 */
export type EnrichmentPanelSense = Omit<EnrichmentView, 'createdAt'>;

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

/** A job is running, so some senses may already be cached and some may not. */
export interface EnrichmentPanelPending extends EnrichmentPanelWorking {
  state: 'pending';
}

/** Every sense the page renders has a cached row. */
export interface EnrichmentPanelReady extends EnrichmentPanelWorking {
  state: 'ready';
}

/**
 * What the entry page and the polling route both answer with.
 *
 * A union rather than one flat object, so `state: 'ready'` and a missing model
 * cannot be expressed at the same time. Three members rather than two, with one
 * literal `state` each: a member carrying `'pending' | 'ready'` narrows its own
 * property but is never removed from the union, so a consumer that has returned
 * for both would still see it in the remainder.
 */
export type EnrichmentPanel = EnrichmentPanelIdle | EnrichmentPanelPending | EnrichmentPanelReady;

export interface ResolveEnrichmentPanelParams {
  headwordId: string;
  /** The sense ids the page renders, in page order. */
  senseIds: string[];
  from: LanguageCode;
  to: LanguageCode;
}

/** The cached rows for `target`, in `target`'s order, with uncached senses left out. */
function orderByTarget(rows: EnrichmentView[], target: string[]): EnrichmentPanelSense[] {
  const bySense = new Map<string, EnrichmentView>();
  for (const row of rows) {
    // The rows arrive newest first, so the first one seen for a sense is the
    // one to keep.
    if (!bySense.has(row.senseId)) bySense.set(row.senseId, row);
  }

  const ordered: EnrichmentPanelSense[] = [];
  for (const senseId of target) {
    const row = bySense.get(senseId);
    if (!row) continue;
    ordered.push({
      senseId: row.senseId,
      provider: row.provider,
      model: row.model,
      promptVersion: row.promptVersion,
      output: row.output,
    });
  }
  return ordered;
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
 * @param params The headword, the senses the page renders, and the direction.
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
  const rows = await listCachedEnrichments(db, {
    headwordId: params.headwordId,
    from: params.from,
    to: params.to,
    model: active.model,
    promptVersion: PROMPT_VERSION,
  });
  const senses = orderByTarget(rows, target);

  if (senses.length === target.length) {
    return { state: 'ready', reason: null, model: active.model, from: params.from, senses };
  }

  // A server with no key can never finish, and skeletons that never resolve are
  // a lie, DESIGN.md rule 3. So the honest answer here is idle with a reason,
  // not a pending panel nobody will ever see complete.
  if (!registry.describeConfiguration(active).configured) {
    return { state: 'idle', reason: 'not-configured', model: active.model, from: params.from, senses: [] };
  }

  return { state: 'pending', reason: null, model: active.model, from: params.from, senses };
}
