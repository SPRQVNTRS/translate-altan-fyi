/**
 * The two brakes between one annoyed reader and a paid model call.
 *
 * WHAT THIS FILE HOLDS IN PLACE
 *   `app/lib/votes/score.ts` decides whether a down-vote is allowed to order a
 *   re-enrichment, and every guard in that decision is arithmetic. A red case
 *   here is a real defect, and it is a defect that spends money: the vote route
 *   asks `isLowQuality(qualityScore(tally))` and queues a provider call when the
 *   answer is true.
 *
 *   1. THE MINIMUM COUNT. Below `MIN_VOTES_FOR_SCORE` there is no score, and
 *      `isLowQuality(null)` is false. Return 0 instead of null there, or let
 *      `isLowQuality` treat null as bad, and ONE click orders a model call.
 *      That is the whole reason the function returns a nullable number, so it
 *      is asserted from both sides.
 *   2. THE LOWER BOUND. At the minimum count the verdict must still depend on
 *      the DIRECTION of the votes: a lopsided-down tally has to land under the
 *      threshold and a lopsided-up tally of the same size has to land over it.
 *      A score that ignored the split would make either every enrichment
 *      re-runnable or none of them, and both readings pass a test that only
 *      checks one tally.
 *   3. THE COOLDOWN. `isCooldownActive` is what stops a small group clicking in
 *      turn from ordering one paid run after another, so the boundary is tested
 *      from BOTH sides. An off-by-one that flips `<` to `<=` is invisible
 *      anywhere else.
 *
 * NO DATABASE, NO NETWORK, NO CLOCK. The module under test has no imports at
 * all and takes `now` as a parameter, so this file needs no mocking of any kind.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  isCooldownActive,
  isLowQuality,
  qualityScore,
  LOW_SCORE_THRESHOLD,
  MIN_VOTES_FOR_SCORE,
  REENRICH_COOLDOWN_HOURS,
  type VoteTally,
} from '../../app/lib/votes/score';

const MS_PER_HOUR = 60 * 60 * 1000;

/** A fixed instant. Every cooldown case is expressed as an offset from it. */
const NOW = new Date('2026-05-04T12:00:00.000Z');

/** `qualityScore` for a tally, failing loudly rather than returning null, for the cases that need a number. */
function scoreOf(tally: VoteTally): number {
  const score = qualityScore(tally);
  // `assert.ok` narrows, so no type assertion is needed to return a number.
  assert.ok(score !== null, `expected a score for up=${tally.up} down=${tally.down}, got null`);
  return score;
}

describe('votes: quality score', () => {
  it('has no score below the minimum vote count, and no verdict either', () => {
    // The case that protects the money. One reader who is annoyed leaves a
    // tally of 0 up and 1 down; a plain ratio reads 0.0, which is below any
    // threshold anybody would pick, so the ONLY thing standing between that
    // click and a provider call is the null.
    const oneAngryReader: VoteTally = { up: 0, down: 1 };

    assert.equal(qualityScore(oneAngryReader), null);
    assert.equal(
      isLowQuality(qualityScore(oneAngryReader)),
      false,
      'a single down-vote produced a low-quality verdict, so one reader can order a paid model call',
    );

    // One vote short of the minimum is still no verdict. This is the boundary
    // the constant actually names, and it is checked from the low side here and
    // from the high side in the next case.
    const justUnder: VoteTally = { up: 0, down: MIN_VOTES_FOR_SCORE - 1 };
    assert.equal(qualityScore(justUnder), null);
    assert.equal(isLowQuality(qualityScore(justUnder)), false);
  });

  it('has no score for a tally nobody has voted on', () => {
    assert.equal(qualityScore({ up: 0, down: 0 }), null);
    assert.equal(isLowQuality(qualityScore({ up: 0, down: 0 })), false);
  });

  it('scores a lopsided-down tally at exactly the minimum below the threshold', () => {
    const tally: VoteTally = { up: 0, down: MIN_VOTES_FOR_SCORE };
    const score = scoreOf(tally);

    assert.ok(
      score <= LOW_SCORE_THRESHOLD,
      `an all-down tally of ${MIN_VOTES_FOR_SCORE} votes scored ${score}, which is above the ` +
        `${LOW_SCORE_THRESHOLD} threshold, so a genuinely bad enrichment can never be re-run`,
    );
    assert.equal(isLowQuality(score), true);
  });

  it('scores a lopsided-up tally of the SAME size above the threshold', () => {
    // The other direction, at the same total, is what makes the case above
    // discriminating. A score that ignored the split would put both tallies on
    // the same side of the line and one of these two cases would catch it.
    const down: VoteTally = { up: 1, down: MIN_VOTES_FOR_SCORE - 1 };
    const up: VoteTally = { up: MIN_VOTES_FOR_SCORE - 1, down: 1 };

    const downScore = scoreOf(down);
    const upScore = scoreOf(up);

    assert.ok(downScore <= LOW_SCORE_THRESHOLD, `a 1 up / ${down.down} down tally scored ${downScore}`);
    assert.ok(
      upScore > LOW_SCORE_THRESHOLD,
      `a ${up.up} up / 1 down tally scored ${upScore}, at or below the ${LOW_SCORE_THRESHOLD} threshold, ` +
        'so a well-received enrichment is re-runnable on demand',
    );
    assert.equal(isLowQuality(upScore), false);
  });

  it('puts an all-up tally at the top of the range and an all-down tally at the bottom', () => {
    const allUp = scoreOf({ up: MIN_VOTES_FOR_SCORE, down: 0 });
    const allDown = scoreOf({ up: 0, down: MIN_VOTES_FOR_SCORE });

    assert.ok(allDown >= 0, `an all-down tally scored ${allDown}, which is outside [0, 1]`);
    assert.ok(allUp <= 1, `an all-up tally scored ${allUp}, which is outside [0, 1]`);
    assert.ok(allUp > allDown, `an all-up tally (${allUp}) did not outscore an all-down tally (${allDown})`);
    assert.equal(isLowQuality(allUp), false);
    assert.equal(isLowQuality(allDown), true);
  });

  it('rises with every up-vote added to a fixed down count', () => {
    // Monotonicity is the property that makes the number a SCORE rather than an
    // arbitrary function of two counts. A formula with a sign error, or one that
    // divided by the wrong total, can still put one hand-picked tally on the
    // right side of the threshold; it cannot stay ordered across a whole run.
    const fixedDown = 3;
    const scores: number[] = [];
    for (let up = 2; up <= 10; up += 1) {
      scores.push(scoreOf({ up, down: fixedDown }));
    }

    for (let index = 1; index < scores.length; index += 1) {
      const previous = scores[index - 1] ?? 0;
      const current = scores[index] ?? 0;
      assert.ok(
        current > previous,
        `adding an up-vote lowered the score: up=${index + 1} scored ${previous}, up=${index + 2} scored ${current}`,
      );
    }

    // And the run must actually cross the threshold, or "rises" would be
    // consistent with a formula that never leaves the low band.
    const first = scores[0] ?? 0;
    const last = scores[scores.length - 1] ?? 0;
    assert.ok(first <= LOW_SCORE_THRESHOLD, `the run starts at ${first}, already above the threshold`);
    assert.ok(last > LOW_SCORE_THRESHOLD, `the run ends at ${last}, still below the threshold`);
  });
});

describe('votes: re-enrichment cooldown', () => {
  it('is not active for a pair that was never queued', () => {
    assert.equal(
      isCooldownActive(null, NOW),
      false,
      'a null timestamp read as an active cooldown, so a pair that was never re-enriched can never be re-enriched',
    );
  });

  it('is active one millisecond before the window closes', () => {
    const lastQueuedAt = new Date(NOW.getTime() - (REENRICH_COOLDOWN_HOURS * MS_PER_HOUR - 1));
    assert.equal(isCooldownActive(lastQueuedAt, NOW), true);
  });

  it('is over exactly at the window boundary', () => {
    // The boundary itself. `elapsed < window` is the implementation, so an
    // elapsed time of exactly the window is OVER. This case and the one above
    // sit one millisecond apart on purpose: together they pin the comparison,
    // and either alone would pass with the wrong operator.
    const lastQueuedAt = new Date(NOW.getTime() - REENRICH_COOLDOWN_HOURS * MS_PER_HOUR);
    assert.equal(isCooldownActive(lastQueuedAt, NOW), false);
  });

  it('is over well after the window closes', () => {
    const lastQueuedAt = new Date(NOW.getTime() - (REENRICH_COOLDOWN_HOURS + 1) * MS_PER_HOUR);
    assert.equal(isCooldownActive(lastQueuedAt, NOW), false);
  });

  it('is active for a timestamp well inside the window', () => {
    const lastQueuedAt = new Date(NOW.getTime() - MS_PER_HOUR);
    assert.equal(
      isCooldownActive(lastQueuedAt, NOW),
      true,
      'a re-enrichment queued an hour ago left the cooldown open, so a group of readers can order paid runs in turn',
    );
  });
});
