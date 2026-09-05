/**
 * The translation pane's client state machine, as a pure function.
 *
 * ONE STATE VALUE, AND EXACTLY ONE. The pane switches on `translationPaneView`
 * once and renders one line; there is no second boolean or flag layered beside
 * it. A refusal is not "translating and also refused", a stall is not "failed
 * and also waiting". Everything the pane shows is derived from the server panel
 * it currently holds plus how long it has been waiting.
 *
 * NO IMPORTS BUT TYPES. This module is reached by the client bundle, and a
 * `.server` value import here would break the production build with nothing
 * earlier catching it. Both imports are `import type` and are erased.
 *
 * WHY THE REDUCER IS SEPARATE FROM THE COMPONENT. There is no DOM library in
 * this repo, so a state machine living inside a component cannot be tested at
 * all. Here it is four transitions over a plain object, and
 * `tests/unit/translation-pane-state.test.ts` drives every one of them without
 * a browser, a timer or a network.
 */

import type { LanguageCode } from '#app/lib/dictionary/detect-language';
import type { TranslationPanel, TranslationRow } from '#app/lib/translation/panel.server';

/** How long between two polls of the read-only companion route. */
export const TRANSLATION_POLL_INTERVAL_MS = 3000;

/**
 * How long the pane waits before it stops polling and changes its line.
 *
 * NINETY SECONDS, AND IT IS NOT A FAILURE. `TRANSLATION_TIMEOUT_MS` bounds the
 * provider call at the same figure, so a run that has not settled by now is
 * either about to write a terminal row or has lost its worker. Either way the
 * job may still be running server-side, so the pane says "come back in a
 * minute" rather than claiming a failure it cannot see. A reload re-reads the
 * run and shows whatever actually happened.
 */
export const TRANSLATION_STALL_AFTER_MS = 90_000;

/** Everything the pane holds: the server's answer, and how long it has waited for a better one. */
export interface TranslationPaneState {
  /** The most recent panel the SERVER produced, from the loader, a poll or a retry. */
  panel: TranslationPanel;
  /** Milliseconds spent polling since the current `translating` panel was adopted. */
  elapsedMs: number;
}

/** The four things that can happen to the pane. */
export type TranslationPaneAction =
  /** A poll interval fired. It is the tick that ages the pane, not a wall clock read. */
  | { type: 'tick' }
  /** A poll came back with a panel. */
  | { type: 'polled'; panel: TranslationPanel }
  /** A poll threw, or answered with a status this pane will not read. */
  | { type: 'poll-failed' }
  /** The retry route answered. Its panel is the reader's own request and is always adopted. */
  | { type: 'adopted'; panel: TranslationPanel };

/**
 * The one value the pane renders from.
 *
 * `stalled` is NOT a sixth server state. It is `translating` seen after ninety
 * seconds: the panel underneath is unchanged, and a poll that lands later still
 * moves the pane to `ready` or `failed` the way it always would.
 */
export type TranslationPaneView = 'ready' | 'translating' | 'stalled' | 'failed' | 'budget' | 'no-entry';

/**
 * What the pane is translating, which is the ONE place the two branches differ.
 *
 * IT IS A UNION RATHER THAN A PAIR OF NULLABLE FIELDS, and that is the whole
 * mechanism keeping one state machine for two branches. A word is polled by
 * headword id and a sentence by its own text, so the two need different URLs and
 * nothing else: same reducer, same five states, same component. Written as
 * `headwordId: string | null` beside `phraseText: string | null` the illegal
 * pair, both set, would be spellable, and the first reader of those two fields
 * would have to invent a rule for it.
 *
 * `none` IS A REAL MEMBER, NOT AN OMISSION. The landing screen and a query that
 * matched no headword both render the pane with nothing to poll, and saying so
 * here is what lets `translationPaneEndpoints` return null exactly once instead
 * of every caller testing two fields.
 */
export type TranslationPaneTarget =
  /** One dictionary word, polled by its headword id. Its rows are dictionary edges. */
  | { kind: 'headword'; headwordId: string; to: LanguageCode }
  /** One typed sentence, polled by the text itself, which the server folds into the cache key. */
  | { kind: 'phrase'; text: string; from: LanguageCode; to: LanguageCode }
  /** Nothing to translate: the landing screen, or a query with no matching headword. */
  | { kind: 'none' };

/** The two routes one target is served by: the read-only poll, and the retry. */
export interface TranslationPaneEndpoints {
  /** GET. It can never enqueue, which is why the pane may call it every three seconds. */
  poll: string;
  /** POST. The one thing the pane does that can spend money, and only on a press. */
  retry: string;
}

/**
 * Where this target is read and retried, or null when there is nothing to ask
 * about.
 *
 * BOTH URLS COME FROM ONE FUNCTION, so a poll and its retry can never address
 * two different things. They used to be two template strings a few lines apart
 * inside the hook, which was safe while there was one branch and one shape.
 *
 * THE PHRASE ROUTES TAKE THE TEXT AS TYPED, NOT A FOLDED KEY. The server folds
 * it with `phraseKeyFromRequest`, which is the same fold the loader used when it
 * queued the run. A client-side fold here would be a second implementation of
 * the cache key, and the day the two disagreed every poll would miss the row the
 * loader had just written while looking perfectly correct.
 *
 * @param target What the pane is translating.
 * @returns The poll and retry URLs, or null for a target with neither.
 */
export function translationPaneEndpoints(target: TranslationPaneTarget): TranslationPaneEndpoints | null {
  if (target.kind === 'headword') {
    const id = encodeURIComponent(target.headwordId);
    return { poll: `/api/translation/${id}?to=${target.to}`, retry: `/api/translation/${id}/retry?to=${target.to}` };
  }
  if (target.kind === 'phrase') {
    const query = `q=${encodeURIComponent(target.text)}&from=${target.from}&to=${target.to}`;
    return { poll: `/api/translation-phrase?${query}`, retry: `/api/translation-phrase/retry?${query}` };
  }
  return null;
}

/**
 * A string that changes exactly when the pane is looking at something else.
 *
 * IT IS THE POLL URL, because that URL already names every part of the target: a
 * different word, a different sentence or a different target language is a
 * different URL. Deriving it here rather than concatenating fields at the call
 * site means a member added to the union above cannot be forgotten by the
 * re-seed while still being polled.
 *
 * @param target What the pane is translating.
 * @returns The seed key, or `none` for a target with nothing to poll.
 */
export function translationPaneSeedKey(target: TranslationPaneTarget): string {
  return translationPaneEndpoints(target)?.poll ?? 'none';
}

/** The pane as it stands the moment the page renders, before any poll. */
export function initialTranslationPaneState(panel: TranslationPanel): TranslationPaneState {
  return { panel, elapsedMs: 0 };
}

/**
 * Which panels a POLL is allowed to overwrite the current one with.
 *
 * ONLY THE TERMINAL THREE. A poll answering `translating` is the older reading
 * of a run that may already have finished, and a poll answering `none` means the
 * run row is not visible to that read yet; adopting either would reset the
 * ninety second clock on every tick, so the pane would never stall and would
 * poll forever. A poll answering `no-entry` is a stale id, which must not wipe
 * an answer already on screen.
 */
function isTerminal(panel: TranslationPanel): boolean {
  return panel.state === 'ready' || panel.state === 'failed' || panel.state === 'budget';
}

/**
 * The next pane state. Pure: same state and action, same answer, every time.
 *
 * A NETWORK FAILURE CHANGES NOTHING AT ALL. A fetch that rejects, or a status
 * this pane will not read, is "ask again next tick" and never a state
 * transition. Only a `translation_runs` row that reads `failed`, arriving as a
 * `failed` panel, moves the pane to `failed`.
 *
 * @param state Where the pane stands.
 * @param action What just happened.
 * @returns The next state, or the same object when nothing changed.
 */
export function translationPaneReducer(
  state: TranslationPaneState,
  action: TranslationPaneAction,
): TranslationPaneState {
  switch (action.type) {
    case 'tick':
      // Only a waiting pane ages. Ticking a settled one would eventually push it
      // past the stall mark and change a line that is already final.
      if (state.panel.state !== 'translating') return state;
      return { panel: state.panel, elapsedMs: state.elapsedMs + TRANSLATION_POLL_INTERVAL_MS };
    case 'polled':
      if (!isTerminal(action.panel)) return state;
      return { panel: action.panel, elapsedMs: 0 };
    case 'poll-failed':
      return state;
    case 'adopted':
      // The reader pressed retry and the server answered. Whatever it says wins,
      // and the clock starts again: a retry that returns `translating` is a NEW
      // run, and charging it with the failed run's ninety seconds would show it
      // as stalled the moment it appeared.
      return { panel: action.panel, elapsedMs: 0 };
  }
}

/**
 * The single value the pane switches on.
 *
 * `none` cannot reach a rendered pane: the loader turns it into `translating` or
 * `budget` before the pane ever sees it, and a polled `none` is refused above.
 * It is mapped rather than thrown, because a pane is not the place to take a
 * screen down over a state nobody can reach.
 */
export function translationPaneView(state: TranslationPaneState): TranslationPaneView {
  const { panel } = state;
  if (panel.state === 'ready') return 'ready';
  if (panel.state === 'failed') return 'failed';
  if (panel.state === 'budget') return 'budget';
  if (panel.state === 'translating') {
    return state.elapsedMs >= TRANSLATION_STALL_AFTER_MS ? 'stalled' : 'translating';
  }
  return 'no-entry';
}

/** Whether the pane should still be asking. It stops the moment it stalls or settles. */
export function isTranslationPanePolling(state: TranslationPaneState): boolean {
  return translationPaneView(state) === 'translating';
}

/** The rows to render, or an empty list for every state that has none. */
export function translationPaneRows(state: TranslationPaneState): TranslationRow[] {
  return state.panel.state === 'ready' ? state.panel.translations : [];
}

/**
 * The one row that IS the answer, or null when there is none yet.
 *
 * A CARD OF COEQUAL WORDS IS A CARD WITH NO ANSWER ON IT. Three generated words
 * side by side made every consumer of this pane take all three: the copy button
 * copied the join, the star saved the join, and the device history logged the
 * join. A reader who had already decided which word was right could not say so
 * anywhere. So one row is the answer and the rest are alternatives, and every
 * consumer reads the answer.
 *
 * THE CHOICE IS THE READER'S, AND IT IS NOT A VOTE. `chosenId` comes from a tap
 * on an alternative. It writes nothing and posts nothing: a vote is a statement
 * about the shared corpus and belongs to everybody, while picking which word to
 * copy is a statement about this screen and belongs to nobody else. `rank.ts`
 * decides the order for everyone, and it deliberately does not read `myVote`.
 *
 * AN UNKNOWN ID FALLS BACK TO THE FIRST ROW, NEVER TO NOTHING. A poll can land a
 * new row set while a choice is held, and a card that emptied itself because the
 * chosen row is gone would be a worse fault than the one this function fixes.
 *
 * @param state Where the pane stands.
 * @param chosenId The row the reader tapped, or null while they have tapped none.
 * @returns The primary row, or null on every state with no rows.
 */
export function translationPanePrimary(
  state: TranslationPaneState,
  chosenId: string | null,
): TranslationRow | null {
  const rows = translationPaneRows(state);
  return rows.find((row) => row.translationId === chosenId) ?? rows[0] ?? null;
}

/**
 * Every row that is not the answer, in the order the server sent them.
 *
 * THE SERVER'S ORDER SURVIVES A CHOICE. `rankTranslationRows` already put these
 * rows in reading order, so promoting one of them must not also reshuffle the
 * others: the reader picked a word, not a new ranking.
 *
 * @param state Where the pane stands.
 * @param chosenId The row the reader tapped, or null while they have tapped none.
 * @returns The remaining rows, empty when there is one row or none.
 */
export function translationPaneAlternatives(
  state: TranslationPaneState,
  chosenId: string | null,
): TranslationRow[] {
  const primary = translationPanePrimary(state, chosenId);
  if (primary === null) return [];
  return translationPaneRows(state).filter((row) => row.translationId !== primary.translationId);
}

/**
 * The answer as one string: the primary word alone.
 *
 * THIS IS THE LINE THAT STOPS THE ALTERNATIVES BEING DRAGGED ALONG. The copy
 * button, the favourite snapshot and the device-local search history all read
 * this one value, so a reader who marked one word as their answer keeps, copies
 * and logs that word rather than every candidate the model offered. The joined
 * form still exists for a reader comparing candidates, as
 * `translationPaneAllText` below, and it is a separate button.
 *
 * @param state Where the pane stands.
 * @param chosenId The row the reader tapped, or null while they have tapped none.
 * @returns The primary word, or an empty string on every state with no answer.
 */
export function translationPaneText(state: TranslationPaneState, chosenId: string | null): string {
  return translationPanePrimary(state, chosenId)?.lemma ?? '';
}

/**
 * Every word of the answer as one string, for the copy-all button.
 *
 * DEDUPLICATED ON THE WORD, because two sources naming the same word is a fact
 * about the dictionary rather than about the word, and a reader copying an
 * answer wants the words once each.
 *
 * IT IS NOT WHAT ANYTHING KEEPS. Nothing is saved or recorded from this value:
 * it exists for the reader who is comparing three candidate terms and wants all
 * three in a document somewhere. That reader used to be served by the only copy
 * button there was, and deleting the join outright would have taken the case
 * away rather than moved it.
 *
 * @param state Where the pane stands.
 * @returns The words once each, comma separated, or an empty string when there
 *   are none.
 */
export function translationPaneAllText(state: TranslationPaneState): string {
  return [...new Set(translationPaneRows(state).map((row) => row.lemma))].join(', ');
}
