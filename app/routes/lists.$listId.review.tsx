import type { Route } from './+types/lists.$listId.review';
import { useTranslation } from 'react-i18next';
import type { MetaFunction } from 'react-router';
import { Link } from '#app/components/link';
import { ReviewSessionView } from '#app/components/review-session';
import { Skeleton } from '#app/components/ui/skeleton';
import { metaLanguage, metaTitle } from '#app/i18n/meta-title';
import type { TitleHandle } from '#app/lib/route-title';
import { getLocalList, listLocalListItems } from '#app/lib/local-store';
import type { ReviewCard } from '#app/lib/review/session';

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

  return (
    <ReviewSessionView
      cards={cards}
      heading={t('review.heading', { name: list.name })}
      backTo={`/lists/${list.id}`}
      backLabel={t('review.backToList')}
    />
  );
}
