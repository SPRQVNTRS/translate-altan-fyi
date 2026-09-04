/**
 * Which three saved words today's nudge offers, as a pure function of the
 * device's own rows.
 *
 * THE SELECTION IS CLIENT WORK, AND IT COULD NOT BE ANYTHING ELSE. Lists,
 * entries and review state live in this browser's store and ride the encrypted
 * blob (`app/lib/local-store/BLOB-CONTENTS.md`); the server cannot read any of it. So
 * there is no route data to ask for, no endpoint to call, and nothing here
 * reaches the network. A device that has been offline all day still gets its
 * three words, because nothing about the decision needed a connection.
 *
 * THIS IS NOT A SCHEDULER, FOR THE SAME REASON `session.ts` is not one. There
 * is no due instant, no ease factor and no interval. The rank is read off two
 * facts the review loop already records: how often a word was answered
 * still-learning, and when it was last seen. Everything else about spaced
 * repetition is a separate product decision, and it would arrive with its own
 * state and its own migration.
 *
 * Pure, and store-free, so the whole rule is testable without a browser. The
 * component in `app/components/daily-nudge.tsx` does the reading and the
 * writing around it.
 */
import type { LocalListItem, LocalReviewState } from '#app/lib/local-store';

/**
 * How many words one day's nudge offers.
 *
 * THREE IS A PRODUCT DECISION, NOT A TUNING PARAMETER. It is small enough to
 * finish in under a minute, which is the entire point of a nudge, and it is
 * deliberately not a setting in v1. The constant exists so the number is
 * findable from either end, not so it can be dialled.
 */
export const DAILY_WORD_COUNT = 3;

/** One offered word, as the nudge and the session it opens both read it. */
export interface DailyWord {
  /** The list entry's id. The review state shares it, and the review screen selects on it. */
  id: string;
  listId: string;
  lemma: string;
  /** The translation AS IT WAS SAVED. The same snapshot the flashcard shows, never a fresh lookup. */
  translation: string;
}

/** The rank keys for one candidate word, in the order they are compared. */
interface RankedWord {
  word: DailyWord;
  /** How often this word was answered still-learning. Higher comes first. */
  stillLearningCount: number;
  /** How long since it was last seen, in ms. Longer comes first, and never-seen is the longest of all. */
  stalenessMs: number;
}

/**
 * How long since a word was last reviewed, in ms.
 *
 * A WORD NEVER REVIEWED IS THE STALEST THERE IS, which is what `Infinity`
 * says. Zero would sort it as freshly seen and park it behind every word the
 * reader has already worked on, so the words most in need of a first look
 * would be the last ones offered.
 *
 * A STAMP FROM THE FUTURE IS CLAMPED TO NOW. `lastReviewedAt` is a wall clock,
 * and wall clock is never an ordering authority in this store: the value may
 * have arrived from another device of the same account whose clock runs fast.
 * Left alone it would read as negative staleness and sort behind everything,
 * so the word would stay unoffered for as long as that clock stayed ahead.
 */
function stalenessMs(lastReviewedAt: number | undefined, now: number): number {
  if (lastReviewedAt === undefined) return Number.POSITIVE_INFINITY;
  return Math.max(0, now - Math.min(lastReviewedAt, now));
}

/**
 * Orders two candidates: most still-learning first, then longest unseen, then
 * by id.
 *
 * THE ID IS A TIEBREAK, NOT A PREFERENCE. Two words with the same tally and no
 * review history are genuinely equal, and `toSorted` is stable, but the input
 * order is a store read whose order is not part of any contract. Comparing ids
 * makes one day's three words the same three whichever way the rows came back.
 */
function byNeed(a: RankedWord, b: RankedWord): number {
  if (a.stillLearningCount !== b.stillLearningCount) return b.stillLearningCount - a.stillLearningCount;
  if (a.stalenessMs !== b.stalenessMs) return b.stalenessMs - a.stalenessMs;
  return a.word.id.localeCompare(b.word.id);
}

/**
 * The words today's nudge offers, at most {@link DAILY_WORD_COUNT} of them.
 *
 * FEWER THAN THREE IS A RESULT, NOT AN ERROR. A reader with two saved words
 * gets two, and a reader with none gets an empty array; the component then
 * renders nothing at all rather than an empty card apologising for itself. A
 * person who has saved nothing yet does not need to be told so on the home
 * screen.
 *
 * WORDS ALREADY SEEN TODAY ARE NOT EXCLUDED. Excluding them would empty the
 * nudge for exactly the reader who reviews every day, which is the reader it
 * is for. They sort last on their own, because a word seen an hour ago is the
 * least stale thing there is.
 *
 * Tombstones are filtered on both sides: a removed word cannot be offered, and
 * a removed review state counts as no review rather than as a zero tally.
 *
 * @param entries - the device's live list entries, from any list.
 * @param reviewState - what the flashcard loop has recorded, keyed by entry id.
 * @param now - epoch-ms, the caller's clock. Used for staleness only.
 */
export function selectDailyWords(
  entries: readonly LocalListItem[],
  reviewState: readonly LocalReviewState[],
  now: number,
): DailyWord[] {
  const stateByEntryId = new Map(reviewState.filter((state) => !state.deleted).map((state) => [state.id, state]));

  return entries
    .filter((entry) => !entry.deleted)
    .map((entry): RankedWord => {
      const state = stateByEntryId.get(entry.id);
      return {
        word: {
          id: entry.id,
          listId: entry.listId,
          lemma: entry.lemma,
          translation: entry.translationSnapshot,
        },
        stillLearningCount: state?.stillLearningCount ?? 0,
        stalenessMs: stalenessMs(state?.lastReviewedAt, now),
      };
    })
    .toSorted(byNeed)
    .slice(0, DAILY_WORD_COUNT)
    .map((ranked) => ranked.word);
}
