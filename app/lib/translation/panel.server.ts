/**
 * What the search pane says about a translation, and whether asking a model for
 * one is the right move.
 *
 * THE SPLIT IS THE SAME ONE `app/lib/enrichment/` MAKES, AND FOR THE SAME
 * REASON.
 *   `resolveTranslationPanel` READS and never enqueues, so the polling route can
 *   call it every three seconds without queueing a fresh job on every poll.
 *   `resolveTriggeredTranslationPanel` is the half that may start work, and the
 *   loader calls it once per search. Folding the two together is how a reader
 *   who waits a minute pays for twenty runs of one translation.
 *
 * THE ZERO-SENSE SHORT CIRCUIT IS GONE, AND THAT IS WHY THIS FILE EXISTS AT
 * ALL.
 *   `resolveEnrichmentPanel` returns idle when a headword has no sense, and
 *   `triggerEnrichment` then returns without enqueuing, so 93.3% of German
 *   headwords could never grow a translation however many readers asked. Here a
 *   headword with no sense is not a reason to stop: it is exactly the case the
 *   job was written to answer, so it falls through to the guards and enqueues.
 *
 * `no-entry` IS NOT THE ENRICHMENT PANEL'S "NO PROVIDER KEY" REASON, AND IT
 * NEVER MAPS ONTO IT.
 *   That panel keeps its two idle reasons apart because collapsing them made a
 *   server with a healthy provider key read exactly like one with no key, which
 *   cost a debugging session. This union carries no configuration reason at all:
 *   `no-entry` means the query matched no headword, it is produced by the LOADER
 *   rather than by either function here, and nothing in this file knows or asks
 *   whether a provider is configured.
 *
 * THE DATABASE IS A PARAMETER, NEVER AN IMPORT.
 */

import { isBudgetExhausted } from '#app/lib/abuse/budget.server';
import { checkTriggerRateLimit } from '#app/lib/abuse/rate-limit.server';
import type { LanguageCode } from '#app/lib/dictionary/detect-language';
import type { DictionaryDb } from '#app/lib/dictionary/queries.server';
import { enqueueTranslation } from '#app/lib/translation/enqueue.server';
import { MAX_TRANSLATION_RUNS_PER_DAY } from '#app/lib/translation/limits';
import { listTranslationsInto, type TranslationRow } from '#app/lib/translation/translations-query.server';
import { countRunsToday, latestRun } from '#app/models/translation-runs.server';
import { PROMPT_VERSION } from '#app/prompts/translation/version';

export type { TranslationRow } from '#app/lib/translation/translations-query.server';

/**
 * Which guard turned a trigger away.
 *
 * ALL THREE RENDER THE SAME SENTENCE, and the distinction is kept anyway. The
 * reader is told one thing, that today's limit is reached and tomorrow is when
 * to come back, because none of the three is actionable and naming the machinery
 * would only be noise. An operator reading a log, or a test asserting the gate
 * ORDER, needs to know which of the three spoke, and a union that collapsed them
 * could not say.
 */
export type TranslationRefusal = 'rate-limited' | 'budget' | 'daily-cap';

/** Translations exist for this pair. Nothing is queued and nothing is spent. */
export interface TranslationPanelReady {
  state: 'ready';
  translations: TranslationRow[];
}

/** A run for this key is open. The pane polls until it is not. */
export interface TranslationPanelTranslating {
  state: 'translating';
}

/**
 * The latest run for this key ended badly.
 *
 * `canRetry` is a literal `true` rather than a boolean, because there is no
 * failed state this product offers no retry for: a translation run is cheap, it
 * writes a NEW append-only row rather than rewriting this one, and the three
 * guards run again on the way. A boolean here would invite a future caller to
 * set it false and leave a reader with a dead end and no way back.
 */
export interface TranslationPanelFailed {
  state: 'failed';
  canRetry: true;
  /** The developer-facing reason, for a log. It is never rendered: the pane shows one translated line. */
  error: string | null;
}

/** A guard refused. Nothing was queued, and nothing is coming today. */
export interface TranslationPanelBudget {
  state: 'budget';
  reason: TranslationRefusal;
}

/**
 * No headword matched the query at all.
 *
 * PRODUCED BY THE LOADER, NEVER BY EITHER FUNCTION HERE. Both of them are given
 * a headword id, so by the time they run the entry exists by construction. The
 * loader is the only caller that can see an empty hit list, so it is the only
 * one that can say this.
 */
export interface TranslationPanelNoEntry {
  state: 'no-entry';
}

/**
 * Nothing has happened for this pair yet.
 *
 * IT IS AN INTERNAL ANSWER, NOT A PANE STATE. The resolver cannot decide what
 * "no translation and no run" should look like, because that depends on whether
 * the caller is allowed to start work: the loader turns it into `translating` or
 * `budget`, and the read-only polling route passes it through unchanged, where
 * the pane treats it as "the run has not been recorded yet, ask again".
 */
export interface TranslationPanelNone {
  state: 'none';
}

/** Everything the translation pane can be told, as one discriminated union. */
export type TranslationPanel =
  | TranslationPanelReady
  | TranslationPanelTranslating
  | TranslationPanelFailed
  | TranslationPanelBudget
  | TranslationPanelNoEntry
  | TranslationPanelNone;

/** The pair a panel is about. One headword, one direction. */
export interface TranslationPanelKey {
  headwordId: string;
  from: LanguageCode;
  to: LanguageCode;
  /**
   * Whose votes to mark as "mine" on the rows this panel carries.
   *
   * IT IS ON THE KEY SO EVERY CALLER HAS TO SEE IT. The reader who is looking
   * at an answer is the reader whose own vote has to be pressed on it, and the
   * three routes that resolve a panel all have a session in hand. Omitting it,
   * or passing `null`, means no per-account read is issued at all and every
   * `myVote` is `null`, which is the right answer for the public polling route
   * when nobody is signed in.
   */
  accountId?: number | null;
}

/**
 * Read the corpus and the run ledger, and say where this pair stands.
 *
 * IT NEVER ENQUEUES AND IT NEVER REFUSES. It holds no request, so it cannot ask
 * the rate limiter anything, and it starts nothing, so it has nothing to refuse.
 *
 * THE CORPUS IS READ FIRST AND WINS OUTRIGHT. A pair with rows is `ready` even
 * when the latest run failed, because a later reader is served the rows and does
 * not care that some earlier attempt to add more of them went wrong.
 *
 * @param db The database handle.
 * @param key The headword and the direction.
 * @returns One of `ready`, `translating`, `failed`, `budget` or `none`.
 */
export async function resolveTranslationPanel(db: DictionaryDb, key: TranslationPanelKey): Promise<TranslationPanel> {
  const translations = await listTranslationsInto(db, {
    headwordId: key.headwordId,
    to: key.to,
    accountId: key.accountId,
  });
  if (translations.length > 0) return { state: 'ready', translations };

  const run = await latestRun(db, key);
  if (run === null) return { state: 'none' };
  if (run.status === 'pending') return { state: 'translating' };
  if (run.status === 'failed') return { state: 'failed', canRetry: true, error: run.error };
  if (run.status === 'budget') return { state: 'budget', reason: 'budget' };
  // `ok` with no rows: the run finished and the model had nothing to add, so
  // there is no answer and nothing is coming. The trigger half decides what to
  // do about that, exactly as it does for a pair nobody has ever asked about.
  return { state: 'none' };
}

export interface ResolveTriggeredTranslationPanelParams extends TranslationPanelKey {
  /** The screen's own request. The rate limiter reads its cookie and its address. */
  request: Request;
  /**
   * Whether the reader asked for this again after a failure.
   *
   * `false`, the search path: a failed pair stays failed, so one provider outage
   * does not re-queue a job on every reload of every word it touched.
   * `true`, the retry button: the reader asked, so the failure is stepped over
   * and the three guards decide.
   */
  retry?: boolean;
}

/**
 * Read, then start the work if starting it is the right move.
 *
 * THE THREE GUARDS RUN IN THIS ORDER, AND THE ORDER IS THE POINT.
 *   `isBudgetExhausted` first: an installation-wide fact, cheap to ask and
 *   settled without touching a per-caller counter. `countRunsToday` against
 *   `MAX_TRANSLATION_RUNS_PER_DAY` second, the only one that costs a query, but
 *   still one that spends nothing of the caller's own allowance.
 *   `checkTriggerRateLimit` LAST, immediately before the enqueue it guards,
 *   because calling it is itself the spend: it bumps the caller's address and
 *   session counters unconditionally, on every call, allowed or not. A search
 *   the other two guards were always going to refuse must not also cost the
 *   reader one of their twenty tokens an hour. This is also why it runs last
 *   rather than first: the enrichment trigger for the same headword calls this
 *   same limiter once per search too, so a search that never reaches enqueue
 *   spends nothing here and the visible cost per search stays that one bump,
 *   not two.
 *
 * A READY OR TRANSLATING PAIR IS NEVER COUNTED AND NEVER REFUSED. Neither one
 * would start work, so running them past the limiter would charge the honest
 * majority for requests that spend nothing, and leave the same allowance to the
 * script walking untranslated words.
 *
 * IT NEVER THROWS. The dictionary rows beside the pane are already a result, so
 * a queue or a guard having an opinion must not turn a search into a 500.
 *
 * @param db The database handle.
 * @param params The pair, the request, and whether this is a retry.
 * @returns The panel to render.
 */
export async function resolveTriggeredTranslationPanel(
  db: DictionaryDb,
  params: ResolveTriggeredTranslationPanelParams,
): Promise<TranslationPanel> {
  const { request, retry = false, headwordId, from, to, accountId } = params;
  const key: TranslationPanelKey = { headwordId, from, to, accountId };

  const resolved = await resolveTranslationPanel(db, key);
  if (resolved.state === 'ready' || resolved.state === 'translating') return resolved;
  if (resolved.state === 'failed' && !retry) return resolved;

  const refusal = await refuseTranslation(db, request);
  if (refusal !== null) return { state: 'budget', reason: refusal };

  // THE QUEUE PAYLOAD IS BUILT FIELD BY FIELD, NOT SPREAD FROM THE KEY. The key
  // now carries an account id so the rows can be marked with the reader's own
  // vote, and a job payload must never carry one: a queued row naming a reader
  // and a headword is the search log this product says it does not keep.
  const outcome = await enqueueTranslation(db, { headwordId, from, to, promptVersion: PROMPT_VERSION });
  // A DEDUPED ENQUEUE IS STILL `translating`. The work is already queued or
  // running under this key, which is what the singleton key exists to arrange,
  // and the run row the first caller opened is what the pane will poll.
  if (outcome.outcome === 'unavailable') {
    return { state: 'failed', canRetry: true, error: 'the translation queue is not available' };
  }
  return { state: 'translating' };
}

/**
 * Which of the three guards turns this trigger away, or `null` when none does.
 *
 * THE RATE LIMIT IS ASKED LAST. It is the only guard that spends anything on
 * the way to a `null`, so the two free questions run first and a pair the
 * budget or the daily cap was always going to refuse never touches it.
 *
 * @param db The database handle, for the day's run count.
 * @param request The caller's own request.
 */
async function refuseTranslation(db: DictionaryDb, request: Request): Promise<TranslationRefusal | null> {
  if (await isBudgetExhausted()) return 'budget';
  if ((await countRunsToday(db)) >= MAX_TRANSLATION_RUNS_PER_DAY) return 'daily-cap';
  const verdict = await checkTriggerRateLimit(request);
  if (!verdict.allowed) return 'rate-limited';
  return null;
}
