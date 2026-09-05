/**
 * ONE ANSWER FOR A WORD AND FOR A SENTENCE.
 *
 * This is the whole body of `POST /api/v1/translate`, and it is a module rather
 * than a route handler for one reason: ADR-0001 says the CLI wraps the API, so
 * the HTTP route and the DirectTransport twin in
 * `cli/lib/direct-transport-handlers.ts` both call THIS function. Two copies
 * would be two programs, and the one nobody runs in development is the one that
 * would drift.
 *
 * THE BRANCH IS DECIDED BY `normalizeQuery(q, from).isPhrase`, WHICH IS THE
 * SAME CALL THE SEARCH LOADER MAKES. A caller must never be able to make the
 * API and the screen disagree about what a phrase is, and the only way to
 * guarantee that is to ask the same function rather than to reimplement its
 * rule. There is no `kind` parameter on the request for the same reason: a
 * caller who could state the branch could state the wrong one.
 *
 * THE ANSWER SHAPE DOES NOT DEPEND ON THE BRANCH. Both halves return a
 * `TranslationPanel`, the same five-state union the pane renders, whose `ready`
 * rows carry a translated word on one branch and a translated sentence on the
 * other. A client must not be able to tell which half answered it, which is the
 * API-side reading of M195 decision 7.
 *
 * IT IS NOT A WAY PAST THE GUARDS. Both halves go through the `resolveTriggered*`
 * functions, which is where the length cap, the per-caller rate limit, the
 * per-day cap and the daily budget live. The `request` is threaded in so the
 * rate limiter reads a real caller rather than a blank one.
 *
 * THE DATABASE IS A PARAMETER, NEVER AN IMPORT.
 */

import { setTimeout as sleep } from 'node:timers/promises';

import type { LanguageCode } from '#app/lib/dictionary/detect-language';
import { normalizeForLanguage, normalizeQuery } from '#app/lib/dictionary/normalize';
import type { DictionaryDb } from '#app/lib/dictionary/queries.server';
import { searchHeadwords } from '#app/lib/dictionary/search.server';
import {
  resolveTranslationPanel,
  resolveTriggeredTranslationPanel,
  type TranslationPanel,
} from '#app/lib/translation/panel.server';
import {
  resolvePhrasePanel,
  resolveTriggeredPhrasePanel,
  type PhrasePanelKey,
} from '#app/lib/translation/phrase-panel.server';

/**
 * How long `wait` will hold a request open, in milliseconds.
 *
 * SHORTER THAN THE PROVIDER TIMEOUT, WHICH IS 90 SECONDS. A run that is still
 * open when this expires is not lost: the answer lands in the cache moments
 * later and the next call for the same text reads it for nothing. Holding an
 * HTTP request open past a minute buys a caller nothing that a second call does
 * not buy them more cheaply.
 */
export const TRANSLATE_WAIT_DEADLINE_MS = 60_000;

/** How often a waiting call re-reads the ledger. */
export const TRANSLATE_WAIT_INTERVAL_MS = 1_000;

/** Which branch answered. Reported, never accepted: the caller does not get to choose. */
export type TranslateKind = 'word' | 'phrase';

/** What `POST /api/v1/translate` answers, for a word and for a sentence alike. */
export interface TranslateAnswer {
  /** The text as it was asked for, trimmed. */
  q: string;
  from: LanguageCode;
  to: LanguageCode;
  kind: TranslateKind;
  /**
   * The dictionary entry the word branch answered about, or null.
   *
   * NULL ON THE PHRASE BRANCH BY CONSTRUCTION, and null on the word branch when
   * no headword matched at all. A sentence is not a lexical entry (decision 2),
   * so there is no id to carry, and the row ids that DO identify the answer
   * travel on the panel's rows either way.
   */
  headwordId: string | null;
  /** The state and the answer, in the five-state union the pane renders. */
  panel: TranslationPanel;
}

/** One call to the endpoint. */
export interface TranslateRequestParams {
  /**
   * The caller's own request, for the rate limiter.
   *
   * IT IS THE REAL ONE OVER HTTP. The direct CLI transport has no request to
   * hand, so it synthesises an empty one, and the limiter treats a caller with
   * no address and no session cookie as unmetered. That is correct there and
   * only there: the CLI entrypoint is the trust boundary for in-process calls,
   * the same rule the rest of `direct-transport-handlers.ts` states. The three
   * installation-wide guards still apply to both.
   */
  request: Request;
  q: string;
  from: LanguageCode;
  to: LanguageCode;
  /** Whether to hold the call open until the run finishes or the deadline expires. */
  wait: boolean;
}

/**
 * Translate one piece of text, whatever shape it is.
 *
 * @param db The database handle.
 * @param params The text, the direction, the caller's request, and whether to
 *   wait for a running job.
 * @returns The branch that answered and the panel it produced.
 */
export async function resolveTranslateRequest(
  db: DictionaryDb,
  params: TranslateRequestParams,
): Promise<TranslateAnswer> {
  const q = params.q.trim();
  const query = normalizeQuery(q, params.from);
  if (query.isPhrase) return translatePhrase(db, { ...params, q }, query.normalized);
  return translateWord(db, { ...params, q }, query.normalized);
}

/** The sentence branch. One key, one run, one translated sentence. */
async function translatePhrase(
  db: DictionaryDb,
  params: TranslateRequestParams,
  normalized: string,
): Promise<TranslateAnswer> {
  const key: PhrasePanelKey = {
    sourceText: params.q,
    sourceNormalized: normalized,
    from: params.from,
    to: params.to,
  };
  const triggered = await resolveTriggeredPhrasePanel(db, { ...key, request: params.request });
  const panel = await settle(triggered, params.wait, () => resolvePhrasePanel(db, key));
  return { q: params.q, from: params.from, to: params.to, kind: 'phrase', headwordId: null, panel };
}

/**
 * The word branch.
 *
 * THE HIT IS CHOSEN THE WAY THE SEARCH SCREEN CHOOSES IT: the exact lemma
 * first, `hits[0]` as the fallback, with the comparison going through the same
 * normaliser that wrote `headwords.lemma_normalized`. A different rule here
 * would answer a different word than the screen does for the same query, which
 * is precisely the drift this endpoint exists to make impossible.
 */
async function translateWord(
  db: DictionaryDb,
  params: TranslateRequestParams,
  normalized: string,
): Promise<TranslateAnswer> {
  const hits = await searchHeadwords(db, { q: params.q, from: params.from, to: params.to });
  const chosen = hits.find((hit) => normalizeForLanguage(hit.lemma, params.from) === normalized) ?? hits[0];

  // NO HEADWORD IS `no-entry`, AND NOTHING IS QUEUED FOR IT. The same answer the
  // loader gives, for the same reason: neither function in `panel.server.ts` can
  // see this case, because both are given a headword id.
  if (chosen === undefined) {
    return {
      q: params.q,
      from: params.from,
      to: params.to,
      kind: 'word',
      headwordId: null,
      panel: { state: 'no-entry' },
    };
  }

  const key = { headwordId: chosen.headwordId, from: params.from, to: params.to };
  const triggered = await resolveTriggeredTranslationPanel(db, { ...key, request: params.request });
  const panel = await settle(triggered, params.wait, () => resolveTranslationPanel(db, key));
  return {
    q: params.q,
    from: params.from,
    to: params.to,
    kind: 'word',
    headwordId: chosen.headwordId,
    panel,
  };
}

/**
 * Hold the call open until the run leaves `translating`, or until the deadline.
 *
 * THE POLL RE-READS, IT NEVER RE-TRIGGERS. `read` is one of the two read-only
 * resolvers, so a caller who waits a minute costs one run and sixty selects
 * rather than sixty runs. That split is the reason those functions exist.
 *
 * THE LOOP IS BOUNDED BY A COUNT, not by a clock it checks itself, so it
 * terminates whatever the database does.
 *
 * @param panel What the trigger returned.
 * @param wait Whether the caller asked to wait at all.
 * @param read The read-only resolver for this key.
 * @returns The terminal panel, or the last one read when the deadline expired.
 */
async function settle(
  panel: TranslationPanel,
  wait: boolean,
  read: () => Promise<TranslationPanel>,
): Promise<TranslationPanel> {
  if (!wait) return panel;
  if (panel.state !== 'translating') return panel;

  const attempts = Math.floor(TRANSLATE_WAIT_DEADLINE_MS / TRANSLATE_WAIT_INTERVAL_MS);
  // The annotation is load-bearing: without it the guard above narrows the
  // initial value to `translating`, and the read below, which returns any of the
  // six, would not assign.
  let latest: TranslationPanel = panel;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    await sleep(TRANSLATE_WAIT_INTERVAL_MS);
    latest = await read();
    if (latest.state !== 'translating') return latest;
  }
  return latest;
}
