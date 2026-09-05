/**
 * The translation pane's client state machine, driven without a browser.
 *
 * WHY THIS FILE EXISTS. The pane makes four promises to a reader, and every one
 * of them is a transition rather than a piece of markup:
 *
 *   1. A poll that lands moves the pane, and only a run row reading `failed`
 *      moves it to `failed`.
 *   2. After ninety seconds it stops asking and changes its line, WITHOUT
 *      claiming a failure, because the run may still be finishing server-side.
 *   3. A poll that throws or answers with an unusable status changes nothing at
 *      all. It is "ask again next tick", and a proxy hiccup must never be shown
 *      to a reader as a failed translation.
 *   4. A retry adopts whatever the server answers, and starts the clock again.
 *
 * There is no DOM library in this repo, so a machine living inside a component
 * could not be tested at all. It is four pure transitions over a plain object
 * instead, and this file drives each one directly.
 *
 * THE STALL IS ASSERTED FROM THE TICK COUNT, NOT FROM A CLOCK. The reducer ages
 * on the interval it is polled at, so these cases run instantly and cannot go
 * flaky on a slow machine.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type { TranslationPanel } from '#app/lib/translation/panel.server';
import {
  initialTranslationPaneState,
  isTranslationPanePolling,
  translationPaneAllText,
  translationPaneAlternatives,
  translationPanePrimary,
  translationPaneReducer,
  translationPaneRows,
  translationPaneText,
  translationPaneView,
  TRANSLATION_POLL_INTERVAL_MS,
  TRANSLATION_STALL_AFTER_MS,
  type TranslationPaneAction,
  type TranslationPaneState,
} from '#app/lib/translation/pane-state';
import { translationBudgetKey } from '#app/components/translation-pane';

const TRANSLATING: TranslationPanel = { state: 'translating' };
const FAILED: TranslationPanel = { state: 'failed', canRetry: true, error: null };
const BUDGET: TranslationPanel = { state: 'budget', reason: 'daily-cap' };
const READY: TranslationPanel = {
  state: 'ready',
  translations: [
    {
      translationId: '2a7d9b1c-4e5f-4a6b-8c9d-0e1f2a3b4c5d',
      lemma: 'devirmek',
      pos: 'verb',
      confidence: 0.9,
      note: null,
      generated: true,
      up: 0,
      down: 0,
      myVote: null,
    },
    {
      translationId: '3b8e0c2d-5f60-4b7c-9d0e-1f2a3b4c5d6e',
      lemma: 'devirmek',
      pos: null,
      confidence: null,
      note: null,
      generated: false,
      up: 0,
      down: 0,
      myVote: null,
    },
  ],
};

/**
 * Three different words for one query, in the order `rankTranslationRows` put
 * them. This is the shape the defect was reported against: the operator looked
 * up one German word, was shown three Turkish ones, up-voted a single one of
 * them, and every consumer of the pane still took all three.
 */
const THREE_ROWS = ['çapa', 'bahçe çapası', 'kazma'].map((lemma, index) => ({
  translationId: `edge-${index + 1}`,
  lemma,
  pos: 'noun',
  confidence: 0.8,
  note: null,
  generated: true,
  up: 0,
  down: 0,
  myVote: null,
}));

const THREE_WORDS: TranslationPanel = { state: 'ready', translations: THREE_ROWS };

/** Apply a list of actions in order, the way a session of the pane would. */
function drive(state: TranslationPaneState, actions: TranslationPaneAction[]): TranslationPaneState {
  return actions.reduce(translationPaneReducer, state);
}

/** As many ticks as it takes to reach the stall mark, and not one more. */
const TICKS_TO_STALL = TRANSLATION_STALL_AFTER_MS / TRANSLATION_POLL_INTERVAL_MS;

describe('the translation pane machine', () => {
  it('starts on whatever the loader answered', () => {
    assert.equal(translationPaneView(initialTranslationPaneState(READY)), 'ready');
    assert.equal(translationPaneView(initialTranslationPaneState(TRANSLATING)), 'translating');
    assert.equal(translationPaneView(initialTranslationPaneState(FAILED)), 'failed');
    assert.equal(translationPaneView(initialTranslationPaneState(BUDGET)), 'budget');
    assert.equal(translationPaneView(initialTranslationPaneState({ state: 'no-entry' })), 'no-entry');
  });

  it('polls while translating, and stops the moment a poll settles it', () => {
    const waiting = initialTranslationPaneState(TRANSLATING);
    assert.equal(isTranslationPanePolling(waiting), true);

    const settled = translationPaneReducer(waiting, { type: 'polled', panel: READY });
    assert.equal(translationPaneView(settled), 'ready');
    assert.equal(isTranslationPanePolling(settled), false);
  });

  it('moves to failed only on a failed panel, and to budget on a refusal', () => {
    const waiting = initialTranslationPaneState(TRANSLATING);
    assert.equal(translationPaneView(translationPaneReducer(waiting, { type: 'polled', panel: FAILED })), 'failed');
    assert.equal(translationPaneView(translationPaneReducer(waiting, { type: 'polled', panel: BUDGET })), 'budget');
  });

  it('ignores a poll that reports nothing terminal, so the clock keeps running', () => {
    // A `none` panel is the read-only route saying "no run is visible yet". A
    // pane that adopted it would reset its elapsed count on every tick and could
    // never reach the stall, so it would poll forever.
    const aged = drive(initialTranslationPaneState(TRANSLATING), [
      { type: 'tick' },
      { type: 'polled', panel: { state: 'none' } },
      { type: 'tick' },
      { type: 'polled', panel: TRANSLATING },
    ]);
    assert.equal(aged.elapsedMs, TRANSLATION_POLL_INTERVAL_MS * 2);
    assert.equal(translationPaneView(aged), 'translating');
  });

  it('does not let a stale no-entry poll wipe an answer already on screen', () => {
    const shown = initialTranslationPaneState(READY);
    const after = translationPaneReducer(shown, { type: 'polled', panel: { state: 'no-entry' } });
    assert.equal(translationPaneView(after), 'ready');
  });

  it('stalls after ninety seconds, and stalling is not failing', () => {
    const ticks: TranslationPaneAction[] = Array.from({ length: TICKS_TO_STALL - 1 }, () => ({ type: 'tick' }));
    const nearly = drive(initialTranslationPaneState(TRANSLATING), ticks);
    assert.equal(translationPaneView(nearly), 'translating');
    assert.equal(isTranslationPanePolling(nearly), true);

    const stalled = translationPaneReducer(nearly, { type: 'tick' });
    assert.equal(stalled.elapsedMs, TRANSLATION_STALL_AFTER_MS);
    assert.equal(translationPaneView(stalled), 'stalled');
    // The whole point of the state: the pane stops asking, and it does NOT claim
    // the run failed, because the run may still be finishing.
    assert.equal(isTranslationPanePolling(stalled), false);
    assert.notEqual(translationPaneView(stalled), 'failed');
  });

  it('still settles a stalled pane if a late poll arrives', () => {
    const ticks: TranslationPaneAction[] = Array.from({ length: TICKS_TO_STALL }, () => ({ type: 'tick' }));
    const stalled = drive(initialTranslationPaneState(TRANSLATING), ticks);
    const late = translationPaneReducer(stalled, { type: 'polled', panel: READY });
    assert.equal(translationPaneView(late), 'ready');
  });

  it('treats a poll that threw as nothing at all', () => {
    const waiting = drive(initialTranslationPaneState(TRANSLATING), [{ type: 'tick' }]);
    const after = translationPaneReducer(waiting, { type: 'poll-failed' });
    assert.equal(after, waiting);
    assert.equal(translationPaneView(after), 'translating');
    assert.equal(isTranslationPanePolling(after), true);
  });

  it('does not age a settled pane, so a final line cannot drift into a stall', () => {
    const ready = initialTranslationPaneState(READY);
    assert.equal(translationPaneReducer(ready, { type: 'tick' }), ready);
    const failed = initialTranslationPaneState(FAILED);
    assert.equal(translationPaneReducer(failed, { type: 'tick' }), failed);
  });

  it('adopts the retry answer and restarts the clock', () => {
    // A failed pane does not age, so this is the state the retry button is
    // pressed from: the failure, however long it has been on screen.
    const stalled = drive(initialTranslationPaneState(FAILED), [{ type: 'tick' }]);
    assert.equal(translationPaneView(stalled), 'failed');

    const retried = translationPaneReducer(stalled, { type: 'adopted', panel: TRANSLATING });
    assert.equal(translationPaneView(retried), 'translating');
    assert.equal(retried.elapsedMs, 0);

    // A retry refused by a guard is adopted just the same: the reader asked, and
    // the answer is that today's limit is reached.
    const refused = translationPaneReducer(stalled, { type: 'adopted', panel: BUDGET });
    assert.equal(translationPaneView(refused), 'budget');
  });

  it('hands the copy button the words once each, and nothing at all before there are any', () => {
    assert.equal(translationPaneAllText(initialTranslationPaneState(READY)), 'devirmek');
    assert.equal(translationPaneRows(initialTranslationPaneState(READY)).length, 2);
    assert.equal(translationPaneAllText(initialTranslationPaneState(TRANSLATING)), '');
    assert.deepEqual(translationPaneRows(initialTranslationPaneState(FAILED)), []);
  });
});

/**
 * The answer, and the words that are not it.
 *
 * WHY THESE CASES EXIST. Three coequal words on one card is a card with no
 * answer on it, and three consumers took the whole list from it: the copy
 * button, the favourite snapshot and the device-local search history. So one row
 * is the answer and the rest are alternatives, a tap moves the answer, and the
 * tap writes and posts nothing. These cases pin the four properties that make
 * that safe, none of which is visible in the markup.
 */
describe('which row is the answer, and which are the alternatives', () => {
  const shown = initialTranslationPaneState(THREE_WORDS);

  it('answers with the first row until the reader chooses another', () => {
    assert.equal(translationPanePrimary(shown, null)?.lemma, 'çapa');
    assert.deepEqual(
      translationPaneAlternatives(shown, null).map((row) => row.lemma),
      ['bahçe çapası', 'kazma'],
    );
  });

  it('promotes the chosen row and leaves the others in the order the server sent', () => {
    // The reader picked the third word. The other two keep `rank.ts`'s order:
    // choosing a word is not choosing a new ranking, and the ranking belongs to
    // everybody who looks the word up.
    assert.equal(translationPanePrimary(shown, 'edge-3')?.lemma, 'kazma');
    assert.deepEqual(
      translationPaneAlternatives(shown, 'edge-3').map((row) => row.lemma),
      ['çapa', 'bahçe çapası'],
    );
  });

  it('falls back to the first row when the chosen id is not in the rows', () => {
    // A poll can land a new row set while a choice is held. An answer card that
    // emptied itself because of that would be worse than the defect this fixes.
    assert.equal(translationPanePrimary(shown, 'edge-gone')?.lemma, 'çapa');
    assert.equal(translationPaneAlternatives(shown, 'edge-gone').length, 2);
  });

  it('gives the star, the history and the copy button the answer alone', () => {
    // This is the whole fix in one assertion: `text` is what the favourite
    // snapshot and `recordSearch` read, and it is one word rather than a join.
    assert.equal(translationPaneText(shown, null), 'çapa');
    assert.equal(translationPaneText(shown, 'edge-2'), 'bahçe çapası');
    assert.notEqual(translationPaneText(shown, null), translationPaneAllText(shown));
  });

  it('keeps the join for the copy-all button, words once each', () => {
    assert.equal(translationPaneAllText(shown), 'çapa, bahçe çapası, kazma');
    // Two sources naming the same word is a fact about the dictionary, not about
    // the word: `READY` holds two rows and one word.
    assert.equal(translationPaneAllText(initialTranslationPaneState(READY)), 'devirmek');
  });

  it('has no alternatives when there is one row', () => {
    const single = initialTranslationPaneState({ state: 'ready', translations: THREE_ROWS.slice(0, 1) });
    assert.equal(translationPanePrimary(single, null)?.lemma, 'çapa');
    assert.deepEqual(translationPaneAlternatives(single, null), []);
  });

  it('has no answer at all on every state that is not ready', () => {
    const others: TranslationPanel[] = [TRANSLATING, FAILED, BUDGET, { state: 'no-entry' }];
    for (const panel of others) {
      const state = initialTranslationPaneState(panel);
      assert.equal(translationPanePrimary(state, null), null);
      assert.deepEqual(translationPaneAlternatives(state, null), []);
      assert.equal(translationPaneText(state, null), '');
      assert.equal(translationPaneAllText(state), '');
    }
  });
});

describe('the budget view copy, which is not one sentence for all three refusals', () => {
  // `pane-state.ts` collapses `rate-limited`, `budget` and `daily-cap` to one
  // `budget` VIEW on purpose: the pane is one switch over one value, and a
  // fourth and fifth view for two refusals that render almost the same markup
  // would be the state machine growing branches for a copy difference. What
  // the copy difference still needs is asserted here instead, against the pure
  // map `app/components/translation-pane.tsx` exports for exactly this reason:
  // there is no DOM library in this repo to render the component and read its
  // text, so the choice between locale keys is tested as the plain function it
  // is.
  it('renders the rate-limit sentence only for a rate-limited refusal', () => {
    assert.equal(translationBudgetKey('rate-limited'), 'enrichment.rateLimited');
  });

  it('renders the shared "nothing more today" sentence for the other two refusals', () => {
    assert.equal(translationBudgetKey('budget'), 'translation.budget');
    assert.equal(translationBudgetKey('daily-cap'), 'translation.budget');
  });

  it('defaults to the shared sentence when no reason is held, which a poll or a first render can be', () => {
    assert.equal(translationBudgetKey(null), 'translation.budget');
  });
});
