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
    { lemma: 'devirmek', pos: 'verb', confidence: 0.9, generated: true },
    { lemma: 'devirmek', pos: null, confidence: null, generated: false },
  ],
};

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
    assert.equal(translationPaneText(initialTranslationPaneState(READY)), 'devirmek');
    assert.equal(translationPaneRows(initialTranslationPaneState(READY)).length, 2);
    assert.equal(translationPaneText(initialTranslationPaneState(TRANSLATING)), '');
    assert.deepEqual(translationPaneRows(initialTranslationPaneState(FAILED)), []);
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
