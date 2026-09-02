/**
 * One flashcard session, and the writes it makes, for whichever screen opened
 * it.
 *
 * TWO SCREENS, ONE SESSION. `/lists/:listId/review` deals a whole list, and
 * `/review?entries=` deals the three words the daily nudge picked. The queue,
 * the flip, the verdict buttons and the tally write are identical in both, so
 * they live here once: a second copy would be a second place for the verdict
 * to be recorded differently, and the recording is the part that outlives the
 * session.
 *
 * The heading and the way back differ, so both are props. Everything else is
 * the same screen.
 */
import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { z } from 'zod';
import { Flashcard } from '#app/components/flashcard';
import { Link } from '#app/components/link';
import { Button } from '#app/components/ui/button';
import { getLocalReviewState, putLocalReviewState } from '#app/lib/local-store';
import { reportError } from '#app/lib/report-error';
import {
  currentCard,
  isReviewComplete,
  recordVerdict,
  REVIEW_VERDICTS,
  startReviewSession,
  type ReviewCard,
  type ReviewSession,
  type ReviewVerdict,
} from '#app/lib/review/session';

/** The tally a review state carries, as it comes back off the store. */
const storedTallySchema = z.object({
  gotItCount: z.number().int().nonnegative(),
  stillLearningCount: z.number().int().nonnegative(),
});

/**
 * Records one verdict against the saved word it was given for.
 *
 * READ, THEN ADD, THEN WRITE. `putLocalReviewState` is an upsert over the whole
 * row, so the previous tally is read first; the alternative would be a counter
 * verb in the store, and that verb would have to invent an answer for two
 * devices counting at once. Last write wins on `(lamport, deviceId)` is the
 * answer this store already gives everywhere else, and a special case here
 * would be a second rule for a reader to learn.
 *
 * The `id` IS the list entry's id. One saved word, one review state.
 */
async function persistVerdict({
  cardId,
  verdict,
  now,
}: {
  cardId: string;
  verdict: ReviewVerdict;
  now: number;
}): Promise<void> {
  const existing = storedTallySchema.safeParse(await getLocalReviewState(cardId));
  const tally = existing.success ? existing.data : { gotItCount: 0, stillLearningCount: 0 };

  await putLocalReviewState({
    id: cardId,
    gotItCount: tally.gotItCount + (verdict === REVIEW_VERDICTS.gotIt ? 1 : 0),
    stillLearningCount: tally.stillLearningCount + (verdict === REVIEW_VERDICTS.stillLearning ? 1 : 0),
    lastReviewedAt: now,
  });
}

/** What one screen has to tell this one: the cards, what to call the session, and the way out of it. */
export interface ReviewSessionViewProps {
  cards: ReviewCard[];
  /** The line above the card. The list's name on a list session, the nudge's own words on the daily one. */
  heading: string;
  backTo: string;
  backLabel: string;
}

/**
 * The session itself: the queue, the flip, and the two writes each verdict
 * makes (one to React state, one to the device).
 *
 * THE SEED IS DRAWN ONCE PER SESSION, in the lazy initialiser and in the
 * "review again" handler, never during a render. A seed re-drawn on every
 * render would reshuffle the queue underneath the reader.
 *
 * THE SCREEN DOES NOT WAIT FOR THE WRITE. The queue advances immediately and
 * the IndexedDB write runs beside it, because a flashcard that stalls between
 * cards is a flashcard nobody uses, and the tally is a record of the session
 * rather than something the next card depends on. A failed write is reported
 * through the error seam rather than swallowed.
 */
export function ReviewSessionView({ cards, heading, backTo, backLabel }: ReviewSessionViewProps) {
  const { t } = useTranslation();
  const [session, setSession] = useState<ReviewSession>(() => startReviewSession({ cards, seed: Date.now() }));
  const [isFlipped, setIsFlipped] = useState(false);
  const [announcement, setAnnouncement] = useState('');

  const card = currentCard(session);

  const onVerdict = useCallback(
    (verdict: ReviewVerdict) => {
      if (card === null) return;

      setSession((previous) => recordVerdict({ session: previous, verdict }));
      setIsFlipped(false);
      setAnnouncement(
        verdict === REVIEW_VERDICTS.gotIt ?
          t('review.gotItAnnouncement', { lemma: card.lemma })
        : t('review.stillLearningAnnouncement', { lemma: card.lemma }),
      );

      const save = async (): Promise<void> => {
        try {
          await persistVerdict({ cardId: card.id, verdict, now: Date.now() });
        } catch (cause) {
          reportError(cause, { scope: 'review.persistVerdict' });
        }
      };
      void save();
    },
    [card, t],
  );

  const onAgain = useCallback(() => {
    setSession(startReviewSession({ cards, seed: Date.now() }));
    setIsFlipped(false);
    setAnnouncement('');
  }, [cards]);

  if (isReviewComplete(session) || card === null) {
    return (
      <div className="mx-auto flex w-full max-w-md flex-col gap-4 text-center">
        <h2 className="font-display text-base font-semibold">{t('review.summaryTitle')}</h2>
        <p className="text-sm text-muted-foreground">
          {t('review.summaryBody', { total: session.totalCards, stillLearning: session.stillLearningCount })}
        </p>
        <Button type="button" onClick={onAgain}>
          {t('review.again')}
        </Button>
        <Link to={backTo} className="text-sm text-primary hover:underline">
          {backLabel}
        </Link>
      </div>
    );
  }

  return (
    <div className="mx-auto flex w-full max-w-md flex-col gap-4">
      <h2 className="text-center font-display text-base font-semibold">{heading}</h2>
      <Flashcard
        card={card}
        isFlipped={isFlipped}
        onFlip={() => setIsFlipped((flipped) => !flipped)}
        onVerdict={onVerdict}
        announcement={announcement}
        progress={t('review.progress', { done: session.retired.length, total: session.totalCards })}
      />
      <Link to={backTo} className="text-center text-sm text-primary hover:underline">
        {backLabel}
      </Link>
    </div>
  );
}
