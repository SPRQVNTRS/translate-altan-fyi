/**
 * Which three words the daily nudge offers, driven directly against the rule.
 *
 * WHAT THIS PROTECTS
 *   `app/lib/review/daily-selection.ts` is the whole selection. It is pure and
 *   store-free on purpose, so the ranking is asserted here rather than through
 *   a rendered card in a browser somebody has to remember to open. The nudge
 *   itself has one job left after this function returns: show what it is given,
 *   or nothing.
 *
 * THE DEFECTS THESE CASES CATCH
 *   - A ranking that reads the tally and ignores how long a word has gone
 *     unseen, so the same three words are offered every day forever.
 *   - A never-reviewed word treated as "seen just now" (a missing row read as
 *     a zero timestamp). The words most in need of a first look would sort
 *     last and never be offered at all.
 *   - Fewer than three eligible words throwing, or padding the result with
 *     something. A short list must yield a short result, and no words at all
 *     must yield an empty array, which is what makes the component render
 *     nothing rather than an empty card.
 *   - A count that drifts away from `DAILY_WORD_COUNT`, asserted through the
 *     constant rather than against a hardcoded 3.
 *   - Tombstones offered as words. A deleted entry is still a row in the
 *     store, and dealing one would put a word the reader removed back on their
 *     home screen.
 *   - A `lastReviewedAt` from a device with a fast clock parking a word behind
 *     everything else for as long as that clock stays ahead.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type { LocalListItem, LocalReviewState } from '#app/lib/local-store';
import { DAILY_WORD_COUNT, selectDailyWords } from '#app/lib/review/daily-selection';

/** A fixed "now", so every case below reasons about one known instant. */
const NOW = Date.UTC(2026, 8, 3, 9, 0, 0);
const MINUTE = 60 * 1000;
const DAY = 24 * 60 * MINUTE;

function entry(id: string, overrides: Partial<LocalListItem> = {}): LocalListItem {
  return {
    id,
    listId: 'list-1',
    headwordId: `headword-${id}`,
    senseId: null,
    lemma: `lemma-${id}`,
    translationSnapshot: `translation-${id}`,
    note: '',
    lamport: 1,
    deviceId: 'device-a',
    updatedAt: NOW,
    deleted: false,
    ...overrides,
  };
}

function reviewed(
  id: string,
  { stillLearningCount, agoMs }: { stillLearningCount: number; agoMs: number },
  overrides: Partial<LocalReviewState> = {},
): LocalReviewState {
  return {
    id,
    gotItCount: 0,
    stillLearningCount,
    lastReviewedAt: NOW - agoMs,
    lamport: 1,
    deviceId: 'device-a',
    updatedAt: NOW,
    deleted: false,
    ...overrides,
  };
}

/** The offered ids, which is what every assertion below is about. */
function offeredIds(words: readonly { id: string }[]): string[] {
  return words.map((word) => word.id);
}

describe('ranking the words', () => {
  it('offers the most still-learning words first', () => {
    const entries = [entry('a'), entry('b'), entry('c'), entry('d')];
    const state = [
      reviewed('a', { stillLearningCount: 1, agoMs: DAY }),
      reviewed('b', { stillLearningCount: 5, agoMs: DAY }),
      reviewed('c', { stillLearningCount: 3, agoMs: DAY }),
      reviewed('d', { stillLearningCount: 0, agoMs: DAY }),
    ];

    assert.deepEqual(offeredIds(selectDailyWords(entries, state, NOW)), ['b', 'c', 'a']);
  });

  it('breaks a tied tally by the oldest last review', () => {
    const entries = [entry('recent'), entry('middling'), entry('ancient')];
    const state = [
      reviewed('recent', { stillLearningCount: 2, agoMs: MINUTE }),
      reviewed('middling', { stillLearningCount: 2, agoMs: 3 * DAY }),
      reviewed('ancient', { stillLearningCount: 2, agoMs: 40 * DAY }),
    ];

    assert.deepEqual(offeredIds(selectDailyWords(entries, state, NOW)), ['ancient', 'middling', 'recent']);
  });

  it('treats a word never reviewed as the oldest of all', () => {
    const entries = [entry('seen-long-ago'), entry('never-seen')];
    const state = [reviewed('seen-long-ago', { stillLearningCount: 0, agoMs: 400 * DAY })];

    assert.deepEqual(offeredIds(selectDailyWords(entries, state, NOW)), ['never-seen', 'seen-long-ago']);
  });

  it('does not let a future timestamp outrank an oldest-first comparison', () => {
    // A stamp that arrived from another device whose clock runs a week fast.
    const entries = [entry('fast-clock'), entry('seen-today')];
    const state = [
      reviewed('fast-clock', { stillLearningCount: 0, agoMs: -7 * DAY }),
      reviewed('seen-today', { stillLearningCount: 0, agoMs: MINUTE }),
    ];

    const offered = offeredIds(selectDailyWords(entries, state, NOW));
    assert.equal(offered.length, 2, 'both words should still be offered');
    assert.equal(offered[0], 'seen-today', 'the word genuinely seen longest ago comes first');
  });

  it('offers no more than the daily count', () => {
    const entries = Array.from({ length: DAILY_WORD_COUNT + 4 }, (_unused, index) => entry(`entry-${index}`));

    assert.equal(selectDailyWords(entries, [], NOW).length, DAILY_WORD_COUNT);
  });

  it('carries the saved lemma and the saved translation snapshot', () => {
    const [word] = selectDailyWords([entry('only')], [], NOW);

    assert.deepEqual(word, {
      id: 'only',
      listId: 'list-1',
      lemma: 'lemma-only',
      translation: 'translation-only',
    });
  });
});

describe('too few words to fill a day', () => {
  it('returns fewer than three when the reader has saved fewer than three', () => {
    const offered = selectDailyWords([entry('a'), entry('b')], [], NOW);

    assert.deepEqual(offeredIds(offered), ['a', 'b']);
  });

  it('returns an empty array, not an error, with fewer than one saved word', () => {
    assert.deepEqual(selectDailyWords([], [], NOW), []);
  });

  it('returns fewer than three when the rest of the words are tombstones', () => {
    const entries = [entry('live'), entry('gone-1', { deleted: true }), entry('gone-2', { deleted: true })];

    assert.deepEqual(offeredIds(selectDailyWords(entries, [], NOW)), ['live']);
  });
});

describe('deleted review state', () => {
  it('counts a tombstoned review state as no review at all', () => {
    const entries = [entry('tombstoned-state'), entry('plain')];
    const state = [
      reviewed('tombstoned-state', { stillLearningCount: 9, agoMs: MINUTE }, { deleted: true }),
      reviewed('plain', { stillLearningCount: 1, agoMs: MINUTE }),
    ];

    assert.deepEqual(offeredIds(selectDailyWords(entries, state, NOW)), ['plain', 'tombstoned-state']);
  });
});
