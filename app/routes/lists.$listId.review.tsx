import type { Route } from './+types/lists.$listId.review';
import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { MetaFunction } from 'react-router';
import { z } from 'zod';
import { Flashcard } from '#app/components/flashcard';
import { Link } from '#app/components/link';
import { Button } from '#app/components/ui/button';
import { Skeleton } from '#app/components/ui/skeleton';
import { metaLanguage, metaTitle } from '#app/i18n/meta-title';
import { reportError } from '#app/lib/report-error';
import type { TitleHandle } from '#app/lib/route-title';
import { getLocalList, getLocalReviewState, listLocalListItems, putLocalReviewState } from '#app/lib/local-store';
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

export const meta: MetaFunction = ({ matches }) => {
  const language = metaLanguage(matches);
  return [
    { title: metaTitle(language, 'review.metaTitle') },
    { name: 'description', content: metaTitle(language, 'review.metaDescription') },
  ];
};

/**
 * The chrome owns the one `h1`, and this screen is not in the nav catalog, so
 * it names itself through the handle rather than rendering a second heading.
 */
export const handle = { titleKey: 'review.metaTitle' } satisfies TitleHandle;

/**
 * Flashcards over one vocabulary list.
 *
 * CLIENT ONLY, LIKE THE LIST IT HANGS OFF. The words are rows in this browser's
 * IndexedDB, so there is nothing for a server to read, nothing an account
 * unlocks, and nothing to fetch mid-session. A whole session therefore runs
 * with the network off. The service worker does not precache this URL, so a
 * HARD reload here while offline lands on `/offline`; the in-app navigation
 * from the list, which is how a reader gets here, works offline.
 *
 * THE CARD BACK IS THE SAVED SNAPSHOT, NOT A FRESH LOOKUP. `translationSnapshot`
 * is what the reader chose to learn at the moment they saved it, and the entry
 * it came from may since have been re-enriched. Reading it live would also make
 * the screen need the network, which is the one thing this screen must not
 * need.
 */
export async function clientLoader({ params }: Route.ClientLoaderArgs) {
  const list = await getLocalList(params.listId);
  if (list === null) return { list: null, cards: [] };

  // `listLocalListItems` already filters tombstones out, so a removed word
  // cannot be dealt back into a session.
  const cards: ReviewCard[] = (await listLocalListItems())
    .filter((item) => item.listId === list.id)
    .map((item) => ({
      id: item.id,
      lemma: item.lemma,
      translation: item.translationSnapshot,
      note: item.note,
    }));

  return { list: { id: list.id, name: list.name }, cards };
}

/** The device answers in a frame or two, so the wait is a shape, not a spinner. */
export function HydrateFallback() {
  return (
    <div className="mx-auto flex w-full max-w-md flex-col gap-6">
      <Skeleton className="h-4 w-24 self-center" />
      <Skeleton className="h-56 w-full" />
      <Skeleton className="h-10 w-full" />
    </div>
  );
}

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
  const tally =
    existing.success ? existing.data : { gotItCount: 0, stillLearningCount: 0 };

  await putLocalReviewState({
    id: cardId,
    gotItCount: tally.gotItCount + (verdict === REVIEW_VERDICTS.gotIt ? 1 : 0),
    stillLearningCount: tally.stillLearningCount + (verdict === REVIEW_VERDICTS.stillLearning ? 1 : 0),
    lastReviewedAt: now,
  });
}

interface ListView {
  id: string;
  name: string;
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
function ReviewSessionView({ list, cards }: { list: ListView; cards: ReviewCard[] }) {
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
        <Link to={`/lists/${list.id}`} className="text-sm text-primary hover:underline">
          {t('review.backToList')}
        </Link>
      </div>
    );
  }

  return (
    <div className="mx-auto flex w-full max-w-md flex-col gap-4">
      <h2 className="text-center font-display text-base font-semibold">{t('review.heading', { name: list.name })}</h2>
      <Flashcard
        card={card}
        isFlipped={isFlipped}
        onFlip={() => setIsFlipped((flipped) => !flipped)}
        onVerdict={onVerdict}
        announcement={announcement}
        progress={t('review.progress', { done: session.retired.length, total: session.totalCards })}
      />
      <Link to={`/lists/${list.id}`} className="text-center text-sm text-primary hover:underline">
        {t('review.backToList')}
      </Link>
    </div>
  );
}

export default function ListReviewRoute({ loaderData }: Route.ComponentProps) {
  const { t } = useTranslation();
  const { list, cards } = loaderData;

  if (list === null) {
    return (
      <div className="mx-auto flex w-full max-w-md flex-col gap-4">
        <p className="text-sm text-muted-foreground">{t('review.notFound')}</p>
        <Link to="/lists" className="text-sm text-primary hover:underline">
          {t('lists.detailBack')}
        </Link>
      </div>
    );
  }

  if (cards.length === 0) {
    return (
      <div className="surface-brand-soft mx-auto flex w-full max-w-md flex-col gap-2 rounded-xl border border-dashed p-6">
        <h2 className="font-display text-base font-semibold">{t('review.emptyTitle')}</h2>
        <p className="text-sm text-muted-foreground">{t('review.emptyBody')}</p>
        <Link to={`/lists/${list.id}`} className="text-sm text-primary hover:underline">
          {t('review.backToList')}
        </Link>
      </div>
    );
  }

  return <ReviewSessionView list={list} cards={cards} />;
}
