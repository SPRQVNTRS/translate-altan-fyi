import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { X } from 'lucide-react';
import { Link } from '#app/components/link';
import { Button } from '#app/components/ui/button';
import {
  getNudgeShownOn,
  listLocalListItems,
  listLocalReviewState,
  localDateKey,
  markNudgeShown,
  shouldShowNudge,
} from '#app/lib/local-store';
import { reportError } from '#app/lib/report-error';
import { selectDailyWords, type DailyWord } from '#app/lib/review/daily-selection';

/**
 * Today's three words, offered once, on the home screen.
 *
 * IT RENDERS NOTHING ON THE SERVER, AND NOTHING ON A FIRST PAINT. The words
 * are rows in this browser's store, so the server has neither the data nor the
 * permission to have it, and the server HTML for `/` is exactly what it was
 * before this component existed. The whole decision runs in an effect after
 * hydration.
 *
 * NOTHING TO OFFER MEANS NOTHING ON SCREEN. A reader who has saved no words
 * yet gets no card, not an empty one explaining its own absence. The home
 * screen already says what to do first.
 *
 * ONCE PER LOCAL DAY, AND THE DAY IS THE DEVICE'S OWN. `nudge.ts` holds the
 * marker and the comparison; the date is written the moment the card is shown,
 * so a reload later the same day does not deal the same three words again, and
 * dismissing is what the reader does to a card they have already been given.
 * The marker never leaves this device.
 *
 * THERE IS NO NOTIFICATION HERE, AND NO PERMISSION PROMPT. Nothing in this
 * file asks the browser for permission to notify, subscribes to push, or
 * reaches the service worker's notification API. The nudge is a card in a
 * screen the reader chose to open. Prior art for a real push implementation is
 * openplate's M131, which is where a later push milestone starts rather than
 * here. The spec's own check greps this tree for those API names, so naming
 * them literally in a comment would fail it, correctly.
 */
export function DailyNudge() {
  const { t } = useTranslation();
  const [words, setWords] = useState<DailyWord[] | null>(null);
  const [isDismissed, setIsDismissed] = useState(false);

  useEffect(() => {
    let isCurrent = true;

    const decide = async (): Promise<void> => {
      const today = localDateKey(new Date());
      if (!shouldShowNudge({ shownOn: await getNudgeShownOn(), today })) return;

      const [entries, reviewState] = await Promise.all([listLocalListItems(), listLocalReviewState()]);
      const selected = selectDailyWords(entries, reviewState, Date.now());
      if (selected.length === 0) return;

      // Marked BEFORE the card is put on screen, not after the reader acts on
      // it. "Shown" is the event this records, and a reader who navigates away
      // without answering has still been offered today's words.
      await markNudgeShown(today);
      if (!isCurrent) return;
      setWords(selected);
    };

    decide().catch((cause) => {
      // A card that cannot be built is not worth an error on the home screen.
      // The search below it is the reason the reader is here.
      reportError(cause, { scope: 'daily-nudge' });
    });

    return () => {
      isCurrent = false;
    };
  }, []);

  if (words === null || isDismissed) return null;

  const reviewHref = `/review?entries=${words.map((word) => encodeURIComponent(word.id)).join(',')}`;

  return (
    <section
      aria-labelledby="daily-nudge-title"
      className="surface-brand-soft flex flex-col gap-3 rounded-xl border p-4"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex flex-col gap-1">
          <h2 id="daily-nudge-title" className="font-display text-base font-semibold">
            {t('nudge.title')}
          </h2>
          <p className="text-sm text-muted-foreground">{t('nudge.body', { count: words.length })}</p>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-8 shrink-0"
          aria-label={t('nudge.dismiss')}
          onClick={() => setIsDismissed(true)}
        >
          <X className="size-4" aria-hidden="true" />
        </Button>
      </div>

      <ul className="flex flex-col gap-1">
        {words.map((word) => (
          <li key={word.id} className="flex flex-wrap items-baseline gap-x-2 text-sm">
            <span className="font-medium">{word.lemma}</span>
            <span className="text-muted-foreground">
              {word.translation === '' ? t('review.noTranslation') : word.translation}
            </span>
          </li>
        ))}
      </ul>

      <Button asChild className="self-start">
        <Link to={reviewHref}>{t('nudge.start')}</Link>
      </Button>
    </section>
  );
}
