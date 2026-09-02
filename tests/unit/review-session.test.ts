/**
 * The review loop's one behavioural promise: a word the reader missed comes
 * back before the session ends, and a word they knew does not.
 *
 * WHAT THIS PROTECTS
 *   `app/lib/review/session.ts` is the whole reordering rule. It is pure, so
 *   these cases drive it directly rather than through a rendered card, and a
 *   change to the rule shows up here rather than in a browser check somebody
 *   has to remember to run.
 *
 * THE DEFECTS THESE CASES CATCH
 *   - A still-learning verdict that retires the card anyway. The word would
 *     silently never return, and the session would still end cleanly, so
 *     nothing else would notice.
 *   - A got-it verdict that re-queues. The session would never terminate.
 *   - A session that ends one card early or one card late, which a "queue
 *     length" assertion alone would miss.
 *   - A shuffle wired to `Math.random`, which would make every assertion about
 *     order untestable and this file quietly weaker over time.
 *   - A scheduling field creeping into the session state.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  currentCard,
  isReviewComplete,
  recordVerdict,
  REVIEW_VERDICTS,
  shuffleWithSeed,
  startReviewSession,
  type ReviewCard,
  type ReviewSession,
} from '#app/lib/review/session';

/** A fixed seed, so every case below reasons about one known order. */
const SEED = 20260902;

function card(id: string): ReviewCard {
  return { id, lemma: `lemma-${id}`, translation: `translation-${id}`, note: '' };
}

const CARDS = [card('a'), card('b'), card('c'), card('d')];

/** Answers the front card with one verdict and hands back the new session. */
function answer(session: ReviewSession, verdict: (typeof REVIEW_VERDICTS)[keyof typeof REVIEW_VERDICTS]): ReviewSession {
  return recordVerdict({ session, verdict });
}

/** What a played-out session left behind: the final state, and every card in the order it was shown. */
interface PlayedSession {
  session: ReviewSession;
  seen: string[];
}

/**
 * Plays a whole session out, giving every card the same verdict until the queue
 * empties. Bounded, so a rule that never retires anything fails as an assertion
 * rather than as a hung test run.
 */
function playOut(
  session: ReviewSession,
  decide: (card: ReviewCard, step: number) => (typeof REVIEW_VERDICTS)[keyof typeof REVIEW_VERDICTS],
): PlayedSession {
  const seen: string[] = [];
  let current = session;
  const maxSteps = 100;
  for (let step = 0; step < maxSteps && !isReviewComplete(current); step += 1) {
    const front = currentCard(current);
    assert.ok(front !== null, 'an incomplete session had no card at the front');
    seen.push(front.id);
    current = answer(current, decide(front, step));
  }
  assert.ok(isReviewComplete(current), 'the session did not end within a bounded number of answers');
  return { session: current, seen };
}

describe('starting a session', () => {
  it('deals every card exactly once and reports the total', () => {
    const session = startReviewSession({ cards: CARDS, seed: SEED });

    assert.equal(session.queue.length, CARDS.length);
    assert.deepEqual(
      session.queue.map((entry) => entry.id).toSorted(),
      CARDS.map((entry) => entry.id).toSorted(),
      'the shuffle lost or duplicated a card',
    );
    assert.equal(session.totalCards, CARDS.length);
    assert.equal(session.gotItCount, 0);
    assert.equal(session.stillLearningCount, 0);
  });

  it('ends immediately for an empty list, rather than showing a card that is not there', () => {
    const session = startReviewSession({ cards: [], seed: SEED });

    assert.equal(isReviewComplete(session), true);
    assert.equal(currentCard(session), null);
    assert.equal(session.totalCards, 0);
  });

  it('carries no scheduling state, which is the requirement rather than an omission', () => {
    const session = startReviewSession({ cards: CARDS, seed: SEED });

    assert.deepEqual(
      Object.keys(session).toSorted(),
      ['gotItCount', 'queue', 'retired', 'stillLearningCount', 'totalCards'],
      'a field appeared on the session state that the no-scheduling rule did not sanction',
    );
  });
});

describe('the shuffle', () => {
  it('is a deterministic function of its seed, so a session is reproducible', () => {
    assert.deepEqual(shuffleWithSeed(CARDS, SEED), shuffleWithSeed(CARDS, SEED));
    assert.deepEqual(
      startReviewSession({ cards: CARDS, seed: SEED }).queue,
      startReviewSession({ cards: CARDS, seed: SEED }).queue,
    );
  });

  it('actually reorders, so the determinism above is not the determinism of doing nothing', () => {
    const many = Array.from({ length: 12 }, (_, index) => card(String(index)));
    const shuffled = shuffleWithSeed(many, SEED).map((entry) => entry.id);

    assert.notDeepEqual(shuffled, many.map((entry) => entry.id), 'the shuffle returned the input order');
    assert.deepEqual(shuffled.toSorted(), many.map((entry) => entry.id).toSorted(), 'the shuffle lost a card');
  });

  it('gives different seeds different orders, so two sessions do not open on the same word', () => {
    const many = Array.from({ length: 12 }, (_, index) => card(String(index)));

    assert.notDeepEqual(
      shuffleWithSeed(many, SEED).map((entry) => entry.id),
      shuffleWithSeed(many, SEED + 1).map((entry) => entry.id),
    );
  });

  it('leaves the caller’s array alone', () => {
    const original = [...CARDS];
    shuffleWithSeed(CARDS, SEED);

    assert.deepEqual(CARDS, original, 'the shuffle mutated its input');
  });
});

describe('still-learning brings the word back inside the session', () => {
  it('returns the word before the session ends, and only then', () => {
    const session = startReviewSession({ cards: CARDS, seed: SEED });
    const first = currentCard(session);
    assert.ok(first !== null);

    // The word is missed once and known on its second showing; every other
    // word is known first time. The session must therefore show that one word
    // twice and end.
    const played = playOut(session, (front, step) =>
      front.id === first.id && step === 0 ? REVIEW_VERDICTS.stillLearning : REVIEW_VERDICTS.gotIt,
    );

    assert.equal(
      played.seen.filter((id) => id === first.id).length,
      2,
      'the missed word did not come back inside the session',
    );
    assert.ok(
      played.seen.lastIndexOf(first.id) > played.seen.indexOf(first.id),
      'the missed word did not reappear after its first showing',
    );
    assert.equal(played.session.stillLearningCount, 1);
    assert.equal(played.session.gotItCount, CARDS.length);
    assert.deepEqual(played.session.retired.toSorted(), CARDS.map((entry) => entry.id).toSorted());
  });

  it('sends the word to the BACK, so there is a gap rather than an immediate repeat', () => {
    const session = startReviewSession({ cards: CARDS, seed: SEED });
    const first = currentCard(session);
    assert.ok(first !== null);

    const after = answer(session, REVIEW_VERDICTS.stillLearning);

    assert.notEqual(currentCard(after)?.id, first.id, 'the missed word came straight back as the next card');
    assert.equal(after.queue.at(-1)?.id, first.id, 'the missed word did not go to the back of the queue');
    assert.equal(after.queue.length, CARDS.length, 'a still-learning verdict changed how many cards are queued');
    assert.deepEqual(after.retired, [], 'a still-learning verdict retired the card');
  });

  it('counts every still-learning verdict, including repeats of one stubborn word', () => {
    const session = startReviewSession({ cards: [card('only')], seed: SEED });

    const played = playOut(session, (_front, step) =>
      step < 3 ? REVIEW_VERDICTS.stillLearning : REVIEW_VERDICTS.gotIt,
    );

    assert.equal(played.session.stillLearningCount, 3);
    assert.equal(played.session.gotItCount, 1);
    assert.equal(played.session.totalCards, 1, 'the denominator moved because a card was re-queued');
  });
});

describe('got-it retires the word', () => {
  it('does not bring it back, and the session ends after exactly one pass', () => {
    const session = startReviewSession({ cards: CARDS, seed: SEED });

    const played = playOut(session, () => REVIEW_VERDICTS.gotIt);

    assert.equal(played.seen.length, CARDS.length, 'a known word was shown twice');
    assert.deepEqual(played.seen.toSorted(), CARDS.map((entry) => entry.id).toSorted());
    assert.equal(played.session.gotItCount, CARDS.length);
    assert.equal(played.session.stillLearningCount, 0);
  });

  it('records the retirement order, so the summary counts what actually happened', () => {
    const session = startReviewSession({ cards: CARDS, seed: SEED });
    const front = currentCard(session);
    assert.ok(front !== null);

    const after = answer(session, REVIEW_VERDICTS.gotIt);

    assert.deepEqual(after.retired, [front.id]);
    assert.equal(after.queue.length, CARDS.length - 1);
    assert.ok(!after.queue.some((entry) => entry.id === front.id), 'the retired word is still queued');
  });
});

describe('answering a finished session', () => {
  it('changes nothing rather than throwing, because a double press is ordinary', () => {
    const finished = playOut(startReviewSession({ cards: CARDS, seed: SEED }), () => REVIEW_VERDICTS.gotIt).session;

    assert.deepEqual(answer(finished, REVIEW_VERDICTS.gotIt), finished);
    assert.deepEqual(answer(finished, REVIEW_VERDICTS.stillLearning), finished);
  });
});
