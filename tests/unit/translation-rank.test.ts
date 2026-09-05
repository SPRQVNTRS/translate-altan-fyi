/**
 * The order the rows of one answer are read in.
 *
 * WHAT THIS FILE HOLDS IN PLACE
 *   `app/lib/translation/rank.ts` decides which translation is THE answer and
 *   which are alternatives. Nothing downstream can notice a wrong order: every
 *   row is a real translation, so a mis-ranked card looks exactly like a
 *   correctly ranked one and the reader copies the first word either way. Four
 *   specific failures are guarded here.
 *
 *   1. IMPORTED LEADS GENERATED, WHATEVER THE VOTES SAY. A curated edge is a
 *      different kind of thing from a model's guess, and a score cannot change
 *      what a row is. Let the score cross that line and an up-voted invention
 *      outranks the dictionary.
 *   2. THE MARGIN. Below `VOTE_MARGIN_THRESHOLD` the score does nothing at all,
 *      so the boundary is asserted from BOTH sides. An off-by-one here lets one
 *      drive-by vote decide the answer on a word nobody else has looked at,
 *      which is exactly what M194 decision 8 refused.
 *   3. THE LOWER KEYS. Confidence breaks a tie and `null` sorts last, then the
 *      word itself. Without the last key the order of two otherwise equal rows
 *      would depend on the order the database happened to return them in.
 *   4. THE INPUT IS NOT MUTATED. The caller's array is handed on to other
 *      readers, and an in-place sort would reorder it under them.
 *
 * NO DATABASE, NO NETWORK, NO CLOCK. The module under test imports one type and
 * nothing else, so this file needs no mocking of any kind.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { rankTranslationRows, VOTE_MARGIN_THRESHOLD } from '#app/lib/translation/rank';
import type { TranslationRow } from '#app/lib/translation/translations-query.server';

/** One row, with everything the ranking reads spelled out and overridable. */
function row(overrides: Partial<TranslationRow> = {}): TranslationRow {
  return {
    translationId: 'b0f1c8a4-2f52-4a1a-9f3d-1c2b3a4d5e6f',
    lemma: 'devirmek',
    pos: 'verb',
    confidence: 0.6,
    note: null,
    generated: true,
    up: 0,
    down: 0,
    myVote: null,
    ...overrides,
  };
}

/** The words, in the order a reader would read them. */
function lemmas(rows: readonly TranslationRow[]): string[] {
  return rankTranslationRows(rows).map((ranked) => ranked.lemma);
}

describe('an imported edge leads a generated one', () => {
  it('puts the imported row first even when the generated one is better voted', () => {
    const imported = row({ lemma: 'imported', generated: false, up: 0, down: 0, confidence: null });
    const generated = row({ lemma: 'generated', generated: true, up: 9, down: 0, confidence: 0.9 });
    assert.deepEqual(lemmas([generated, imported]), ['imported', 'generated']);
  });

  it('still ranks the generated rows among themselves', () => {
    const imported = row({ lemma: 'imported', generated: false });
    const weak = row({ lemma: 'weak', up: 0, down: 3 });
    const strong = row({ lemma: 'strong', up: 3, down: 0 });
    assert.deepEqual(lemmas([weak, strong, imported]), ['imported', 'strong', 'weak']);
  });
});

describe('the vote margin', () => {
  it('does not reorder on a net margin of one', () => {
    // One reader is not agreement. The two rows fall through to the alphabet,
    // which is where they stood before anybody clicked anything.
    const voted = row({ lemma: 'zebra', up: 1, down: 0, confidence: 0.6 });
    const quiet = row({ lemma: 'alpha', up: 0, down: 0, confidence: 0.6 });
    assert.deepEqual(lemmas([quiet, voted]), ['alpha', 'zebra']);
  });

  it('reorders on a net margin of two', () => {
    const voted = row({ lemma: 'zebra', up: 2, down: 0, confidence: 0.6 });
    const quiet = row({ lemma: 'alpha', up: 0, down: 0, confidence: 0.6 });
    assert.deepEqual(lemmas([quiet, voted]), ['zebra', 'alpha']);
  });

  it('sinks a row the same way once the margin is met downwards', () => {
    const disliked = row({ lemma: 'alpha', up: 0, down: VOTE_MARGIN_THRESHOLD, confidence: 0.6 });
    const quiet = row({ lemma: 'zebra', up: 0, down: 0, confidence: 0.6 });
    assert.deepEqual(lemmas([disliked, quiet]), ['zebra', 'alpha']);
  });

  it('reads the MARGIN, not the total, so a busy row with no agreement stays put', () => {
    // Nine up and eight down is seventeen readers and no verdict. Ranking on the
    // raw count instead of the margin would promote it over a quiet row.
    const busy = row({ lemma: 'zebra', up: 9, down: 8, confidence: 0.6 });
    const quiet = row({ lemma: 'alpha', up: 0, down: 0, confidence: 0.6 });
    assert.deepEqual(lemmas([busy, quiet]), ['alpha', 'zebra']);
  });
});

describe('the keys below the votes', () => {
  it('breaks a tie on confidence, descending', () => {
    const sure = row({ lemma: 'zebra', confidence: 0.9 });
    const unsure = row({ lemma: 'alpha', confidence: 0.3 });
    assert.deepEqual(lemmas([unsure, sure]), ['zebra', 'alpha']);
  });

  it('sorts a stated confidence ahead of none', () => {
    const stated = row({ lemma: 'zebra', confidence: 0.3 });
    const none = row({ lemma: 'alpha', confidence: null });
    assert.deepEqual(lemmas([none, stated]), ['zebra', 'alpha']);
  });

  it('falls through to the word itself when everything else is equal', () => {
    const rows = [row({ lemma: 'ceviz' }), row({ lemma: 'armut' }), row({ lemma: 'badem' })];
    assert.deepEqual(lemmas(rows), ['armut', 'badem', 'ceviz']);
  });

  it('ignores the reader\'s own vote entirely', () => {
    // Two readers with opposite votes must see the same answer, or the shared
    // corpus view has quietly become a personalised one.
    const neutral = [row({ lemma: 'zebra', confidence: 0.9 }), row({ lemma: 'alpha', confidence: 0.3 })];
    const upVotedTheWeakerRow = [
      row({ lemma: 'zebra', confidence: 0.9, myVote: -1 }),
      row({ lemma: 'alpha', confidence: 0.3, myVote: 1 }),
    ];
    assert.deepEqual(lemmas(upVotedTheWeakerRow), lemmas(neutral));
  });
});

describe('the input array', () => {
  it('is not mutated', () => {
    const rows = [row({ lemma: 'zebra', confidence: 0.9 }), row({ lemma: 'alpha', confidence: 0.3 })];
    const before = rows.map((each) => each.lemma);
    const ranked = rankTranslationRows(rows);
    assert.deepEqual(
      rows.map((each) => each.lemma),
      before,
      'the caller\'s array was sorted in place',
    );
    assert.notEqual(ranked, rows, 'the same array instance was handed back');
  });
});
