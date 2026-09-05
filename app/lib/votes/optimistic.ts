/**
 * The arithmetic behind a vote button that answers before the server does.
 *
 * WHY IT IS ITS OWN MODULE, AND WHY IT IS SHARED.
 *   Two controls now post a vote: the enrichment one under a set of study notes,
 *   and the translation one on every row of an answer. Both show a count that
 *   moves on the click rather than on the response, and both have to subtract
 *   the reader's previous vote while adding the new one. That subtraction is the
 *   part that is easy to get wrong and impossible to see going wrong: a second
 *   copy of it would drift, and the drift would read as a flickering number
 *   rather than as a bug. One copy, in a module with no imports, is also a copy
 *   the unit tier can drive directly.
 *
 * NO IMPORTS AND NO REACT. Nothing here reads a hook, a request or a clock, so
 * `tests/unit/vote-optimistic.test.ts` holds it to arithmetic with nothing in
 * front of it.
 */

/** The two directions a vote can point. There is no neutral vote: not voting is neutral. */
export type VoteChoice = -1 | 1;

/** The score as a button renders it, whether it came from the server or from a click. */
export interface VoteTallyView {
  up: number;
  down: number;
  myVote: VoteChoice | null;
}

/**
 * The vote a submission is carrying, read back out of the request itself.
 *
 * THE OPTIMISTIC FIGURE COMES FROM `fetcher.formData`, NOT FROM STATE.
 *   The in-flight request already holds what the reader clicked, so mirroring it
 *   into a `useState` inside an effect would be a second copy of a fact the
 *   router is already holding, and the two would disagree for one render on
 *   every click.
 *
 * The value is compared as the STRING a form actually sends. A form body has no
 * numbers in it.
 *
 * @param formData The body of the submission in flight, or `undefined` when
 *   there is none.
 * @returns the vote being sent, or `null` when nothing is in flight.
 */
export function submittedVote(formData: FormData | undefined): VoteChoice | null {
  if (formData === undefined) return null;
  const raw = formData.get('value');
  if (raw === '1') return 1;
  if (raw === '-1') return -1;
  return null;
}

/**
 * The score as it will read once this vote lands.
 *
 * One vote per reader, so casting a vote also RETRACTS the reader's previous
 * one. Adding without subtracting would let a reader who changes their mind
 * count twice for one render, which is the same arithmetic error the upsert in
 * the model layer exists to prevent on the server.
 *
 * @param base The score the server last confirmed, with the reader's own vote.
 * @param next The vote just clicked.
 * @returns the score to show while the request is in flight.
 */
export function applyVote(base: VoteTallyView, next: VoteChoice): VoteTallyView {
  return {
    up: base.up + (next === 1 ? 1 : 0) - (base.myVote === 1 ? 1 : 0),
    down: base.down + (next === -1 ? 1 : 0) - (base.myVote === -1 ? 1 : 0),
    myVote: next,
  };
}
