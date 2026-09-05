/**
 * What the search pane says about a typed SENTENCE, and whether asking a model
 * for one is the right move.
 *
 * THE SPLIT IS THE SAME ONE `panel.server.ts` MAKES, AND FOR THE SAME REASON.
 *   `resolvePhrasePanel` READS and never enqueues, so the polling route can call
 *   it every three seconds without queueing a fresh job on every poll.
 *   `resolveTriggeredPhrasePanel` is the half that may start work, and the
 *   loader calls it once per search. Folding the two together is how a reader
 *   who waits a minute pays for twenty runs of one sentence.
 *
 * IT ANSWERS THE SAME UNION THE WORD PATH ANSWERS, AND THAT IS A PRODUCT RULE,
 * NOT A CONVENIENCE.
 *   A reader must not be able to tell which branch answered them. The pane has
 *   exactly five states and renders one component; a phrase-shaped panel type
 *   would mean a second component, a second set of sentences, and two features
 *   that drift. So `ready` here carries one row, whose `lemma` is the translated
 *   sentence.
 *
 * THE CACHE IS READ FIRST AND WINS OUTRIGHT. A sentence with an answer is
 * `ready` even when a later attempt failed, because the reader is served the
 * answer and does not care that some retry went wrong afterwards. That is the
 * same shape as the word path reading the corpus before the run ledger.
 *
 * THE DATABASE IS A PARAMETER, NEVER AN IMPORT.
 */

import { isBudgetExhausted } from '#app/lib/abuse/budget.server';
import { checkTriggerRateLimit } from '#app/lib/abuse/rate-limit.server';
import { isServedLanguage, type LanguageCode } from '#app/lib/dictionary/detect-language';
import { normalizeQuery } from '#app/lib/dictionary/normalize';
import type { DictionaryDb } from '#app/lib/dictionary/queries.server';
import { MAX_PHRASE_RUNS_PER_DAY, PHRASE_MAX_CHARS } from '#app/lib/translation/limits';
import { enqueuePhrase } from '#app/lib/translation/phrase-enqueue.server';
import type { TranslationPanel, TranslationRefusal } from '#app/lib/translation/panel.server';
import type { TranslationRow } from '#app/lib/translation/translations-query.server';
import { countPhraseRunsToday, latestPhrase, latestPhraseAnswer } from '#app/models/phrase-runs.server';
import { PHRASE_PROMPT_VERSION } from '#app/prompts/phrase/version';

export type { TranslationPanel } from '#app/lib/translation/panel.server';

/** Which sentence, in which direction. */
export interface PhrasePanelKey {
  /** The text as the reader typed it, trimmed. It is what a new run would translate. */
  sourceText: string;
  /** The folded form, `normalizeQuery(sourceText, from).normalized`, which is the cache key. */
  sourceNormalized: string;
  from: LanguageCode;
  to: LanguageCode;
}

/**
 * One answered sentence, in the shape the pane already renders.
 *
 * `pos` IS NULL AND `generated` IS TRUE, both by construction. A sentence has no
 * part of speech, and every sentence on this path was written by a model, so
 * neither field is ever anything else.
 *
 * `translationId` CARRIES THE `phrase_translations` ROW ID, WHICH IS NOT AN EDGE
 * ID. Votes point at a dictionary edge, and there is no edge behind a sentence,
 * so the vote control must not be offered on a phrase answer. The id is carried
 * anyway because it identifies the row a reader is looking at, which is what a
 * report or a retraction would need. The counters are zero and the reader's own
 * vote is null for the same reason: nobody can vote on this.
 */
function toRow(id: string, translation: string): TranslationRow {
  return { translationId: id, lemma: translation, pos: null, confidence: null, generated: true, up: 0, down: 0, myVote: null };
}

/**
 * Read the cache and the ledger, and say where this sentence stands.
 *
 * IT NEVER ENQUEUES AND IT NEVER REFUSES. It holds no request, so it cannot ask
 * the rate limiter anything, and it starts nothing, so it has nothing to refuse.
 *
 * @param db The database handle.
 * @param key The sentence and the direction.
 * @returns One of `ready`, `translating`, `failed`, `budget` or `none`.
 */
export async function resolvePhrasePanel(db: DictionaryDb, key: PhrasePanelKey): Promise<TranslationPanel> {
  const answered = await latestPhraseAnswer(db, key);
  if (answered !== null && answered.translationText !== null) {
    return { state: 'ready', translations: [toRow(answered.id, answered.translationText)] };
  }

  const row = await latestPhrase(db, key);
  if (row === null) return { state: 'none' };
  if (row.status === 'pending') return { state: 'translating' };
  if (row.status === 'failed') return { state: 'failed', canRetry: true, error: row.error };
  if (row.status === 'budget') return { state: 'budget', reason: 'budget' };
  // `ok` with no text: the check above already returned for every readable
  // answer, so this is a row the writer left empty. It is treated as "nothing is
  // coming", exactly like a sentence nobody has ever asked about, and the
  // trigger half decides what to do next.
  return { state: 'none' };
}

export interface ResolveTriggeredPhrasePanelParams extends PhrasePanelKey {
  /** The screen's own request. The rate limiter reads its cookie and its address. */
  request: Request;
  /**
   * Whether the reader asked for this again after a failure.
   *
   * `false`, the search path: a failed sentence stays failed, so one provider
   * outage does not re-queue a job on every reload.
   * `true`, the retry button: the reader asked, so the failure is stepped over
   * and the guards decide.
   */
  retry?: boolean;
}

/**
 * Read, then start the work if starting it is the right move.
 *
 * THE FOUR GUARDS RUN IN THIS ORDER, AND THE ORDER IS THE POINT.
 *   The LENGTH CAP first, because it is free and certain: it needs no query, no
 *   clock and no shared counter, and a text over the cap can never be translated
 *   however much budget is left, so asking anything else about it would be work
 *   spent on a refusal that was already decided.
 *   The RATE LIMIT second. It is the per-caller guard, and it is what stands
 *   between one script and the whole day's allowance: a caller already over it
 *   must not be able to read the installation's counters by paying nothing for
 *   the answer.
 *   The PER-DAY PHRASE CAP third, and the BUDGET last, both installation-wide.
 *
 * AN ANSWERED OR RUNNING SENTENCE IS NEVER COUNTED AND NEVER REFUSED. Neither
 * one would start work, so running them past the limiter would charge the honest
 * majority for requests that spend nothing.
 *
 * IT NEVER THROWS. The dictionary rows beside the pane are already a result, so
 * a queue or a guard having an opinion must not turn a search into a 500.
 *
 * @param db The database handle.
 * @param params The sentence, the direction, the request, and whether this is a
 *   retry.
 * @returns The panel to render.
 */
export async function resolveTriggeredPhrasePanel(
  db: DictionaryDb,
  params: ResolveTriggeredPhrasePanelParams,
): Promise<TranslationPanel> {
  const { request, retry = false, sourceText, sourceNormalized, from, to } = params;
  const key: PhrasePanelKey = { sourceText, sourceNormalized, from, to };

  const resolved = await resolvePhrasePanel(db, key);
  if (resolved.state === 'ready' || resolved.state === 'translating') return resolved;
  if (resolved.state === 'failed' && !retry) return resolved;

  const refusal = await refusePhrase(db, request, sourceText);
  // A refusal WRITES NOTHING. No row is opened, so nothing newer than the
  // existing state exists, and a reader who comes back under a fresh allowance
  // reaches the same enqueue this one did not.
  if (refusal !== null) return { state: 'budget', reason: refusal };

  const outcome = await enqueuePhrase(db, { from, to, sourceText, sourceNormalized, promptVersion: PHRASE_PROMPT_VERSION });
  // A DEDUPED ENQUEUE IS STILL `translating`. The work is already queued or
  // running under this key, which is what the singleton key exists to arrange,
  // and the row the first caller opened is what the pane will poll.
  if (outcome.outcome === 'unavailable') {
    return { state: 'failed', canRetry: true, error: 'the translation queue is not available' };
  }
  return { state: 'translating' };
}

/**
 * Which guard turns this trigger away, or `null` when none does.
 *
 * The order is stated on `resolveTriggeredPhrasePanel` and proved by
 * `tests/unit/phrase-panel-gate.test.ts`, which reads the call log rather than
 * the returned reason: asserting only the reason would pass on an
 * implementation that asked every guard and picked a winner afterwards, which
 * is a different program.
 *
 * @param db The database handle, for the day's run count.
 * @param request The caller's own request.
 * @param sourceText The text as typed, which is what the length cap measures.
 */
async function refusePhrase(db: DictionaryDb, request: Request, sourceText: string): Promise<TranslationRefusal | null> {
  if (sourceText.length > PHRASE_MAX_CHARS) return 'too-long';
  const verdict = await checkTriggerRateLimit(request);
  if (!verdict.allowed) return 'rate-limited';
  if ((await countPhraseRunsToday(db)) >= MAX_PHRASE_RUNS_PER_DAY) return 'daily-cap';
  if (await isBudgetExhausted()) return 'budget';
  return null;
}

/**
 * The key one polling request is about, read out of its query string.
 *
 * IT IS HERE RATHER THAN IN EACH ROUTE so the poll and the retry fold the text
 * the SAME way. Two copies of this would be two cache keys, and the second one
 * would miss every row the first one wrote while looking exactly right.
 *
 * @param url The request's URL. `q` is the text, `from` and `to` the direction.
 * @returns The key, or null when the text is empty or a language is not served.
 *   Null is not an error: a stale poll is an ordinary thing, and the route
 *   answers it with the same panel it would give an unknown word.
 */
export function phraseKeyFromRequest(url: URL): PhrasePanelKey | null {
  const raw = url.searchParams.get('q')?.trim() ?? '';
  const from = url.searchParams.get('from');
  const to = url.searchParams.get('to');
  if (raw === '' || !isServedLanguage(from) || !isServedLanguage(to)) return null;

  const normalized = normalizeQuery(raw, from).normalized;
  if (normalized === '') return null;
  return { sourceText: raw, sourceNormalized: normalized, from, to };
}
