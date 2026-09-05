/**
 * The order the rows of one answer are shown in.
 *
 * WHY THERE IS AN ORDER AT ALL. `listTranslationsInto` returns its rows
 * alphabetically, and a card that renders three coequal words is a card with no
 * answer on it: the reader picks the first one, which is a fact about the
 * alphabet rather than about the language. This module decides which row is the
 * answer and which are the alternatives, and it is the ONE place that decides
 * it, so the pane and anything else reading the same rows cannot disagree.
 *
 * THE READER'S OWN VOTE IS DELIBERATELY NOT A SORT KEY.
 *   `myVote` is on every row and it is not read here. If it were, two readers
 *   looking up the same word would be shown two different primary answers, and
 *   the shared corpus view would quietly become a personalised one without
 *   anybody choosing that. Choosing which term is the answer FOR ME is a view
 *   action in the pane, not a vote, and a vote is a statement about the corpus.
 *
 * THE MARGIN OF TWO IS THE GUARD ON M194 DECISION 8.
 *   That decision said a translation vote is recorded and nothing else: no
 *   re-run, no hiding, no reordering. This is a bounded amendment to it, not a
 *   reversal. A score only moves the answer once at least two readers agree, so
 *   on a low-traffic headword one drive-by vote cannot flip the word every later
 *   reader copies and saves. Below the margin the score is treated as nothing
 *   and the row falls through to the next key, which is where it stood before.
 *
 * IMPORTED LEADS GENERATED REGARDLESS OF SCORE.
 *   A human-curated edge outranks a model's guess, and no vote count changes
 *   what a row IS. A generated row that collects up-votes is still a generated
 *   row, so it is ranked among the generated ones rather than promoted past an
 *   import.
 *
 * PURE, AND TYPE IMPORTS ONLY. The pane reads this, so the module is reached by
 * the client bundle: no `.server` value import may ever be added, and nothing
 * here may read a clock, a request or a database.
 */

import type { TranslationRow } from '#app/lib/translation/translations-query.server';

/**
 * How far apart the up and down votes must be before the score moves a row.
 *
 * TWO, meaning two readers who agree. One is a drive-by: a single click on a
 * word nobody else has looked at would otherwise decide what every later reader
 * is shown first. See the margin paragraph in the module comment.
 */
export const VOTE_MARGIN_THRESHOLD = 2;

/**
 * The net score as the ranking reads it, which is zero until the margin is met.
 *
 * @param row The row to score.
 * @returns `up - down` once the two sides are `VOTE_MARGIN_THRESHOLD` apart, and
 *   0 below that, so an undecided row is ordered by the keys after this one.
 */
function decisiveScore(row: TranslationRow): number {
  const net = row.up - row.down;
  return Math.abs(net) >= VOTE_MARGIN_THRESHOLD ? net : 0;
}

/**
 * Confidence as a number the comparison can order, with `null` last.
 *
 * A missing confidence is not a low one: an imported edge that states none is
 * usually a curated fact. It is ranked after every stated confidence anyway,
 * because the imported rows already lead on the first key, so this only ever
 * separates two rows that are otherwise equal.
 *
 * @param confidence The edge's own confidence, 0 to 1, or `null`.
 * @returns The value to compare, descending. `-1` sorts below every real one.
 */
function confidenceOrNegative(confidence: number | null): number {
  return confidence ?? -1;
}

/**
 * The rows in the order a reader should read them: the answer first, then the
 * alternatives.
 *
 * The precedence, in full: an imported edge before a generated one, then the net
 * vote score descending once it is decisive, then confidence descending with
 * `null` last, then the word itself. The last key is `localeCompare` rather than
 * `<`, because the target languages here include Turkish and German and a
 * code-point comparison puts `ç`, `ö` and `ü` after `z`.
 *
 * @param rows The rows as the corpus read returned them.
 * @returns A NEW array. The input is never sorted in place: it belongs to the
 *   caller, and a loader that handed the same array to two consumers would
 *   otherwise see it reordered under the second one.
 */
export function rankTranslationRows(rows: readonly TranslationRow[]): TranslationRow[] {
  return rows.toSorted((left, right) => {
    if (left.generated !== right.generated) return left.generated ? 1 : -1;

    const scoreDifference = decisiveScore(right) - decisiveScore(left);
    if (scoreDifference !== 0) return scoreDifference;

    const confidenceDifference = confidenceOrNegative(right.confidence) - confidenceOrNegative(left.confidence);
    if (confidenceDifference !== 0) return confidenceDifference;

    return left.lemma.localeCompare(right.lemma);
  });
}
