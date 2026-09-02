import { useTranslation } from 'react-i18next';
import { Button } from '#app/components/ui/button';
import { REVIEW_VERDICTS, type ReviewCard, type ReviewVerdict } from '#app/lib/review/session';

/**
 * One flashcard and its two verdict controls.
 *
 * PRESENTATIONAL ON PURPOSE. It holds no session, no store and no timer: the
 * route owns the queue (`app/lib/review/session.ts`) and the writes, and hands
 * this component a card, a flipped flag and two callbacks. That split is what
 * lets the reordering rule be unit tested with no DOM, and it keeps this file
 * to layout and accessibility.
 *
 * THE CARD IS A REAL `<button>`, NOT A DIV WITH A CLICK HANDLER. A button is
 * already reachable by Tab, already fires on both Enter and Space, and already
 * announces itself as an interactive control, so nothing here re-implements
 * keyboard handling that the platform does correctly. `aria-pressed` carries
 * the flip: the card is a toggle, and a screen reader reads its state on focus
 * rather than only at the moment it changes.
 *
 * THE VERDICT IS ANNOUNCED IN A LIVE REGION, and the region is rendered
 * ALWAYS, empty when there is nothing to say. A live region that is mounted at
 * the same moment its text appears is frequently not announced at all, because
 * the assistive technology never observed the change. An always-present region
 * whose text is swapped is the shape that works.
 *
 * The two verdicts are ordinary buttons in source order after the card, so Tab
 * reaches the card, then still-learning, then got-it, which is the order a
 * reader meets them on screen.
 */
export interface FlashcardProps {
  card: ReviewCard;
  isFlipped: boolean;
  onFlip: () => void;
  onVerdict: (verdict: ReviewVerdict) => void;
  /** What the live region should say right now. Empty means nothing has happened yet. */
  announcement: string;
  /** The progress line above the card, already formatted by the route. */
  progress: string;
}

export function Flashcard({ card, isFlipped, onFlip, onVerdict, announcement, progress }: FlashcardProps) {
  const { t } = useTranslation();

  return (
    <div className="flex w-full flex-col gap-4">
      <p className="text-center text-xs text-muted-foreground tabular-nums">{progress}</p>

      <button
        type="button"
        onClick={onFlip}
        aria-pressed={isFlipped}
        aria-label={t('review.cardLabel', { lemma: card.lemma })}
        className="flex min-h-56 w-full flex-col items-center justify-center gap-3 rounded-2xl border bg-card p-6 text-card-foreground shadow-sm transition-shadow hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
      >
        <span className="font-display text-2xl font-semibold break-words">{card.lemma}</span>

        {isFlipped && (
          <span className="text-base text-muted-foreground break-words">
            {card.translation === '' ? t('search.noTranslationYet') : card.translation}
          </span>
        )}

        {isFlipped && card.note !== '' && (
          <span className="text-xs text-muted-foreground">
            <span className="font-medium">{t('review.noteLabel')}</span> {card.note}
          </span>
        )}

        <span className="text-xs text-muted-foreground">
          {isFlipped ? t('review.flipBack') : t('review.flipToAnswer')}
        </span>
      </button>

      <div className="flex gap-3">
        <Button type="button" variant="outline" className="flex-1" onClick={() => onVerdict(REVIEW_VERDICTS.stillLearning)}>
          {t('review.stillLearning')}
        </Button>
        <Button type="button" className="flex-1" onClick={() => onVerdict(REVIEW_VERDICTS.gotIt)}>
          {t('review.gotIt')}
        </Button>
      </div>

      <p aria-live="polite" className="min-h-4 text-center text-xs text-muted-foreground">
        {announcement}
      </p>
    </div>
  );
}
