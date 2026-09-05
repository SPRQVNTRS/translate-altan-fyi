/**
 * The arithmetic a vote button does before the server answers.
 *
 * WHY THIS IS WORTH A TEST OF ITS OWN
 *   `applyVote` is the one place a count can be wrong in a way nobody sees. A
 *   reader who changes their mind holds ONE row on the server, because the
 *   composite primary key on both vote tables makes a second vote replace the
 *   first. A client that added the new vote without subtracting the old one
 *   would show a reader counted twice for one render, then snap back when the
 *   response landed. That reads as a flicker, not as a bug, and nothing else in
 *   the stack would catch it: the server figures are right, so an integration
 *   test passes while every clicking reader sees a wrong number.
 *
 * NO DOM, NO ROUTER, NO DATABASE. `app/lib/votes/optimistic.ts` imports nothing,
 * which is why the two controls that share it can be driven here as arithmetic.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { applyVote, submittedVote, type VoteTallyView } from '#app/lib/votes/optimistic';

/** A score with nobody's own vote on it. */
function tally(up: number, down: number, myVote: -1 | 1 | null = null): VoteTallyView {
  return { up, down, myVote };
}

/** A form body carrying one field, as `fetcher.formData` would hold it. */
function body(value: string): FormData {
  const form = new FormData();
  form.set('value', value);
  return form;
}

describe('submittedVote', () => {
  it('reads the two votes back as the STRINGS a form actually sends', () => {
    assert.equal(submittedVote(body('1')), 1);
    assert.equal(submittedVote(body('-1')), -1);
  });

  it('answers null when nothing is in flight', () => {
    assert.equal(submittedVote(undefined), null);
  });

  it('answers null for a body carrying anything else', () => {
    assert.equal(submittedVote(new FormData()), null, 'a body with no value field was read as a vote');
    assert.equal(submittedVote(body('0')), null, "'0' is not one of the two values the check constraint allows");
    assert.equal(submittedVote(body('true')), null);
  });
});

describe('applyVote', () => {
  it('adds a first up-vote', () => {
    assert.deepEqual(applyVote(tally(3, 1), 1), { up: 4, down: 1, myVote: 1 });
  });

  it('adds a first down-vote', () => {
    assert.deepEqual(applyVote(tally(3, 1), -1), { up: 3, down: 2, myVote: -1 });
  });

  it('moves the count across when a reader changes their mind', () => {
    assert.deepEqual(
      applyVote(tally(4, 1, 1), -1),
      { up: 3, down: 2, myVote: -1 },
      'the previous up-vote was not retracted. One reader holds one row on the server, so a changed vote MOVES ' +
        'a count rather than adding a second one.',
    );
    assert.deepEqual(applyVote(tally(3, 2, -1), 1), { up: 4, down: 1, myVote: 1 });
  });

  it('leaves the total unchanged when a reader clicks the button they already hold', () => {
    const before = tally(4, 1, 1);
    const after = applyVote(before, 1);
    assert.deepEqual(after, { up: 4, down: 1, myVote: 1 });
    assert.equal(
      after.up + after.down,
      before.up + before.down,
      'clicking the same button twice grew the tally, so a single reader can push a score by clicking again',
    );
  });

  it('never counts one reader twice, however many times they click', () => {
    let shown = tally(0, 0);
    for (const next of [1, -1, 1, -1, -1, 1] as const) {
      shown = applyVote(shown, next);
      assert.equal(
        shown.up + shown.down,
        1,
        `after voting ${next} the reader is counted ${shown.up + shown.down} times`,
      );
    }
  });

  it('does not mutate the score it was given', () => {
    const before = tally(2, 2, -1);
    applyVote(before, 1);
    assert.deepEqual(before, { up: 2, down: 2, myVote: -1 }, 'the settled tally was mutated, so a re-render drifts');
  });
});
