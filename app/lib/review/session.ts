/**
 * The review loop, as pure functions of their arguments.
 *
 * A SESSION IS A QUEUE, AND THAT IS THE WHOLE MODEL. The words of one list are
 * shuffled once, the reader answers the card at the front, and the answer
 * decides whether that card leaves or goes to the back. When the queue empties
 * the session is over. There is no clock in here, no storage, and no React, so
 * the reordering rule is testable without a browser.
 *
 * THERE IS NO SCHEDULING ALGORITHM HERE, AND ITS ABSENCE IS THE REQUIREMENT.
 * No ease factor, no growing gaps, no "due" instant, no SM-2. The milestone
 * README states it in plain words so the next reader does not go looking for a
 * half-built one. A hard word comes back because it is put at the BACK OF THIS
 * SESSION, and for no other reason. Adding a real algorithm is a separate
 * product decision that would arrive with its own state and its own migration.
 *
 * WHY STILL-LEARNING GOES TO THE BACK RATHER THAN A FEW CARDS ON. Both bring
 * the word round again inside the session, and the back of the queue is the
 * one that needs no tuning parameter: a position N would be a number somebody
 * has to justify, and it degenerates anyway once the queue is shorter than N.
 * With a short list the back is only a few cards away, which is the gap the
 * spec asks for; with a long one it is a genuine break.
 *
 * The persisted half of this feature (`reviewState` in the local store) is
 * written by the route, not here. This module never touches it, so a session
 * can be replayed in a test without a store.
 */

/** The two verdicts a reader can give a card. The identifiers are the ones the copy keys and the counters use. */
export const REVIEW_VERDICTS = {
  gotIt: 'gotIt',
  stillLearning: 'stillLearning',
} as const;

/** One verdict. */
export type ReviewVerdict = (typeof REVIEW_VERDICTS)[keyof typeof REVIEW_VERDICTS];

/**
 * One card in a session: what the reader saved, as they saved it.
 *
 * `translation` is the entry's stored snapshot rather than a fresh lookup, so
 * a session runs with the network off and re-enrichment never rewrites the
 * card under someone mid-review.
 */
export interface ReviewCard {
  id: string;
  lemma: string;
  translation: string;
  note: string;
}

/**
 * A session in progress.
 *
 * Every field is readonly and every transition returns a new value, so a React
 * state update is a replacement rather than a mutation, and a test can hold
 * two states side by side and compare them.
 */
export interface ReviewSession {
  /** The cards still to answer, front first. A still-learning card appears here twice over a session's life, never at once. */
  readonly queue: readonly ReviewCard[];
  /** The ids that have been answered got-it, in the order they were retired. */
  readonly retired: readonly string[];
  /** How many cards the session started with. The denominator of the progress line. */
  readonly totalCards: number;
  /** How many got-it verdicts were given. Equal to `retired.length`, kept as its own field so the summary reads without arithmetic. */
  readonly gotItCount: number;
  /** How many still-learning verdicts were given. Can exceed `totalCards`: one stubborn word can be answered this way repeatedly. */
  readonly stillLearningCount: number;
}

/**
 * A small seeded generator, so a shuffle is reproducible from its seed alone.
 *
 * `Math.random` would make the order untestable, and an unshuffled order would
 * make every session start with the same word. The seed is the caller's to
 * choose: the route passes a fresh instant, and a test passes a constant.
 */
function createSeededRandom(seed: number): () => number {
  let state = Math.trunc(seed) >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let drawn = Math.imul(state ^ (state >>> 15), 1 | state);
    drawn = (drawn + Math.imul(drawn ^ (drawn >>> 7), 61 | drawn)) ^ drawn;
    return ((drawn ^ (drawn >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Fisher-Yates over a copy, driven by {@link createSeededRandom}. Exported
 * because the determinism is a property worth asserting on its own, separately
 * from the queue behaviour built on top of it.
 */
export function shuffleWithSeed<T>(items: readonly T[], seed: number): T[] {
  const shuffled = [...items];
  const random = createSeededRandom(seed);
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const swapWith = Math.floor(random() * (index + 1));
    const held = shuffled[index];
    const other = shuffled[swapWith];
    if (held === undefined || other === undefined) continue;
    shuffled[index] = other;
    shuffled[swapWith] = held;
  }
  return shuffled;
}

/**
 * Starts a session over one list's cards.
 *
 * SHUFFLED ONCE, HERE, AND NEVER AGAIN. Re-shuffling on each answer would let
 * a card the reader just missed jump back to the front, which is the opposite
 * of the gap the loop is for.
 *
 * An empty list produces a session that is already complete. That is not an
 * error: a list with nothing in it has nothing to review, and the route shows
 * the summary rather than a card.
 */
export function startReviewSession({ cards, seed }: { cards: readonly ReviewCard[]; seed: number }): ReviewSession {
  return {
    queue: shuffleWithSeed(cards, seed),
    retired: [],
    totalCards: cards.length,
    gotItCount: 0,
    stillLearningCount: 0,
  };
}

/** The card facing the reader, or null when the session is over. */
export function currentCard(session: ReviewSession): ReviewCard | null {
  return session.queue[0] ?? null;
}

/** Whether the queue is empty, which is the only way a session ends. */
export function isReviewComplete(session: ReviewSession): boolean {
  return session.queue.length === 0;
}

/**
 * Records a verdict on the card at the front and advances.
 *
 * Got-it retires the card: it leaves the queue and cannot come back this
 * session. Still-learning moves it to the BACK, so the reader meets it again
 * before the session ends. That asymmetry is the entire reordering rule.
 *
 * Answering an empty session returns the same session rather than throwing. A
 * double-click on the last card is the ordinary way to reach that, and the
 * honest answer to "answer nothing" is "nothing changed".
 */
export function recordVerdict({
  session,
  verdict,
}: {
  session: ReviewSession;
  verdict: ReviewVerdict;
}): ReviewSession {
  const [front, ...rest] = session.queue;
  if (front === undefined) return session;

  if (verdict === REVIEW_VERDICTS.gotIt) {
    return {
      ...session,
      queue: rest,
      retired: [...session.retired, front.id],
      gotItCount: session.gotItCount + 1,
    };
  }

  return {
    ...session,
    queue: [...rest, front],
    stillLearningCount: session.stillLearningCount + 1,
  };
}
