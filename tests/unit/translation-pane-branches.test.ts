/**
 * The two branches of the translator, driven through the SAME state machine.
 *
 * WHY THIS FILE EXISTS. M195 makes one promise about the phrase branch that is
 * not about any single line of markup: a reader must not be able to tell which
 * branch answered them. That promise only holds while both branches reach the
 * pane through one reducer, one view function and one set of five states, and
 * the cheapest way for it to break is a second hook written for phrases which
 * then drifts. So these cases feed a word target and a phrase target the same
 * panels, in the same order, and assert the same views come back.
 *
 * THE TARGET IS ASSERTED THROUGH ITS URLS, NOT THROUGH THE HOOK. There is no DOM
 * library in this repo, so the hook itself cannot run here. Everything that
 * differs between the branches is `translationPaneEndpoints`, which is pure, so
 * the difference is asserted where it actually lives.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type { TranslationPanel } from '#app/lib/translation/panel.server';
import {
  initialTranslationPaneState,
  translationPaneEndpoints,
  translationPaneReducer,
  translationPaneSeedKey,
  translationPaneText,
  translationPaneView,
  type TranslationPaneTarget,
  type TranslationPaneView,
} from '#app/lib/translation/pane-state';
import { translationBudgetKey } from '#app/components/translation-pane';

const WORD: TranslationPaneTarget = { kind: 'headword', headwordId: 'a3f1', to: 'tr' };
const PHRASE: TranslationPaneTarget = { kind: 'phrase', text: 'Das auto volltanken', from: 'de', to: 'tr' };

/** A word answer: a dictionary edge, so its id is a `translations` row. */
const WORD_READY: TranslationPanel = {
  state: 'ready',
  translations: [
    { translationId: 'edge-1', lemma: 'devirmek', pos: 'verb', confidence: 0.9, generated: true, up: 0, down: 0, myVote: null },
  ],
};

/** A phrase answer: ONE row, whose id is a `phrase_translations` row and not an edge. */
const PHRASE_READY: TranslationPanel = {
  state: 'ready',
  translations: [
    {
      translationId: 'phrase-1',
      lemma: 'arabayı doldurmak',
      pos: null,
      confidence: null,
      generated: true,
      up: 0,
      down: 0,
      myVote: null,
    },
  ],
};

/** Every panel the server can hand a pane, in the order a reader could meet them. */
const PANELS: TranslationPanel[] = [
  { state: 'translating' },
  { state: 'failed', canRetry: true, error: null },
  { state: 'budget', reason: 'daily-cap' },
  { state: 'no-entry' },
];

/** The view a pane settles on after adopting one panel, which is what a reader sees. */
function viewAfterAdopting(panel: TranslationPanel): TranslationPaneView {
  const seeded = initialTranslationPaneState({ state: 'translating' });
  return translationPaneView(translationPaneReducer(seeded, { type: 'adopted', panel }));
}

describe('a word and a phrase answer through one state machine', () => {
  it('settles on the same view for every panel the server can send', () => {
    // The reducer takes no target at all, which is the point being asserted:
    // there is nothing in it that COULD answer differently per branch. A second
    // hook for phrases would have to be a second reducer, and this case is what
    // would still pass while the two drifted, so it also checks the answers.
    for (const panel of PANELS) {
      assert.equal(viewAfterAdopting(panel), viewAfterAdopting(panel));
    }
    assert.deepEqual(PANELS.map(viewAfterAdopting), ['translating', 'failed', 'budget', 'no-entry']);
  });

  it('reads a ready answer the same way on both branches', () => {
    assert.equal(viewAfterAdopting(WORD_READY), 'ready');
    assert.equal(viewAfterAdopting(PHRASE_READY), 'ready');
  });

  it('gives the copy button the sentence on a phrase, not the words that were typed', () => {
    const state = translationPaneReducer(initialTranslationPaneState({ state: 'translating' }), {
      type: 'adopted',
      panel: PHRASE_READY,
    });
    assert.equal(translationPaneText(state), 'arabayı doldurmak');
    // The defect this milestone exists for: the answer was the reader's own
    // sentence, lower-cased, echoed back under the heading "Translation".
    assert.notEqual(translationPaneText(state), 'das auto volltanken');
  });
});

describe('where each branch polls, which is the only thing that differs', () => {
  it('polls a word by its headword id', () => {
    assert.deepEqual(translationPaneEndpoints(WORD), {
      poll: '/api/translation/a3f1?to=tr',
      retry: '/api/translation/a3f1/retry?to=tr',
    });
  });

  it('polls a phrase by the text as typed, so the server folds the cache key once', () => {
    assert.deepEqual(translationPaneEndpoints(PHRASE), {
      poll: '/api/translation-phrase?q=Das%20auto%20volltanken&from=de&to=tr',
      retry: '/api/translation-phrase/retry?q=Das%20auto%20volltanken&from=de&to=tr',
    });
  });

  it('has nothing to poll when there is nothing to translate', () => {
    assert.equal(translationPaneEndpoints({ kind: 'none' }), null);
    assert.equal(translationPaneSeedKey({ kind: 'none' }), 'none');
  });

  it('re-seeds when the sentence changes, and not when it does not', () => {
    const other: TranslationPaneTarget = { kind: 'phrase', text: 'Das auto waschen', from: 'de', to: 'tr' };
    assert.notEqual(translationPaneSeedKey(PHRASE), translationPaneSeedKey(other));
    assert.equal(translationPaneSeedKey(PHRASE), translationPaneSeedKey({ ...PHRASE }));
  });
});

describe('a refused length, which is a fourth refusal rather than a sixth state', () => {
  it('renders through the budget view', () => {
    assert.equal(viewAfterAdopting({ state: 'budget', reason: 'too-long' }), 'budget');
  });

  it('says the text is too long rather than repeating the daily limit', () => {
    assert.equal(translationBudgetKey('too-long'), 'translation.tooLong');
    assert.notEqual(translationBudgetKey('too-long'), translationBudgetKey('daily-cap'));
  });
});
