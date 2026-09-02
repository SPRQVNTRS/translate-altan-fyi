/**
 * The quality score a re-enrichment decision is taken from, and the two brakes
 * that stand between a down-vote and a paid model call.
 *
 * WHY A WILSON LOWER BOUND AND NOT up / (up + down).
 *   A plain ratio has no memory of how many people voted. One reader who is
 *   annoyed leaves 0 up and 1 down, the ratio reads 0.0, and that enrichment is
 *   now the WORST ENTRY IN THE DICTIONARY, below anything with a hundred votes
 *   and a real problem. Whatever threshold sits under that ratio, a single
 *   click has crossed it, so one reader can order a paid model call at will.
 *   The Wilson lower bound answers a different question: given these votes, how
 *   low could the true approval rate plausibly be. With one vote the interval is
 *   nearly the whole range, so the lower bound stays far from a verdict; with
 *   forty votes the interval is narrow and the bound sits close to the observed
 *   ratio. Sample size is built into the number rather than bolted beside it.
 *
 * WHY THERE IS A MINIMUM COUNT AS WELL.
 *   Because each brake alone has a hole. The lower bound is smooth, so a
 *   threshold placed anywhere still has SOME tiny vote count that crosses it,
 *   and picking that threshold correctly is a judgement nobody has made yet.
 *   `MIN_VOTES_FOR_SCORE` is the blunt one: below it there is no score at all,
 *   so no threshold can be crossed by any arithmetic. Conversely a count alone
 *   would let five annoyed readers, arriving together, look exactly like five
 *   hundred, which is what the lower bound refuses. Both are kept because
 *   removing either one re-opens a way to spend money on one person's mood.
 *
 * NO IMPORTS, ON PURPOSE. Nothing here reads a database, a clock or a request,
 * so the unit tier can hold it to arithmetic with nothing in front of it.
 */

/** Below this many total votes there is no score. See the file comment. */
export const MIN_VOTES_FOR_SCORE = 5;

/** A score at or below this is a verdict of "low quality". */
export const LOW_SCORE_THRESHOLD = 0.35;

/** How long one (headword, direction) pair must wait between queued re-enrichments. */
export const REENRICH_COOLDOWN_HOURS = 72;

/** The z value for a 95% confidence interval. */
export const WILSON_Z = 1.96;

/** The two counts a score is computed from. Nothing else, ever. */
export interface VoteTally {
  up: number;
  down: number;
}

const MS_PER_HOUR = 60 * 60 * 1000;

/**
 * The Wilson score lower bound on `up / (up + down)`, at z = 1.96.
 *
 * @param tally The up and down counts for one enrichment.
 * @returns a number in `[0, 1]`, or `null` when there are fewer than
 *   `MIN_VOTES_FOR_SCORE` votes. `null` means NO VERDICT, not "bad".
 */
export function qualityScore(tally: VoteTally): number | null {
  const total = tally.up + tally.down;
  if (total < MIN_VOTES_FOR_SCORE) return null;

  // Written out with named intermediates rather than as one expression. The
  // formula is short enough to fit on a line and impossible to check on one.
  const observed = tally.up / total;
  const zSquared = WILSON_Z * WILSON_Z;

  // The interval is not centred on the observed rate: it is pulled towards 0.5
  // by an amount that shrinks as the sample grows. That pull is what stops one
  // vote from being treated as a measurement.
  const centre = observed + zSquared / (2 * total);
  const spread = (observed * (1 - observed) + zSquared / (4 * total)) / total;
  const margin = WILSON_Z * Math.sqrt(spread);
  const denominator = 1 + zSquared / total;

  return (centre - margin) / denominator;
}

/**
 * Whether a score is bad enough to consider re-running the enrichment.
 *
 * @param score The output of {@link qualityScore}.
 * @returns `false` for `null`. A missing verdict can never trigger a re-run,
 *   which is the whole reason `qualityScore` returns `null` rather than 0.
 */
export function isLowQuality(score: number | null): boolean {
  if (score === null) return false;
  return score <= LOW_SCORE_THRESHOLD;
}

/**
 * Whether this (headword, direction) pair is still inside its cooldown window.
 *
 * @param lastQueuedAt When a re-enrichment was last queued for the pair, or
 *   `null` when one never was.
 * @param now The current time, passed in so this stays pure.
 * @returns `false` for a `null` timestamp: never queued means there is nothing
 *   to wait for, not that the caller must wait forever.
 */
export function isCooldownActive(lastQueuedAt: Date | null, now: Date): boolean {
  if (lastQueuedAt === null) return false;
  const elapsedMs = now.getTime() - lastQueuedAt.getTime();
  return elapsedMs < REENRICH_COOLDOWN_HOURS * MS_PER_HOUR;
}
