import type { Route } from './+types/review';
import { useTranslation } from 'react-i18next';
import type { MetaFunction } from 'react-router';
import { Link } from '#app/components/link';
import { ReviewSessionView } from '#app/components/review-session';
import { Skeleton } from '#app/components/ui/skeleton';
import { metaLanguage, metaTitle } from '#app/i18n/meta-title';
import type { TitleHandle } from '#app/lib/route-title';
import { listLocalListItems } from '#app/lib/local-store';
import { DAILY_WORD_COUNT } from '#app/lib/review/daily-selection';
import type { ReviewCard } from '#app/lib/review/session';

export const meta: MetaFunction = ({ matches }) => {
  const language = metaLanguage(matches);
  return [
    { title: metaTitle(language, 'nudge.metaTitle') },
    { name: 'description', content: metaTitle(language, 'nudge.metaDescription') },
  ];
};

/** The chrome owns the one `h1`, and this screen is not in the nav catalog, so it names itself. */
export const handle = { titleKey: 'nudge.metaTitle' } satisfies TitleHandle;

/** The entry ids named by `?entries=`, in the order the caller wrote them, at most a day's worth. */
function parseEntryIds(url: string): string[] {
  const raw = new URL(url).searchParams.get('entries') ?? '';
  return raw
    .split(',')
    .map((id) => id.trim())
    .filter((id) => id !== '')
    .slice(0, DAILY_WORD_COUNT);
}

/**
 * A session over named saved words, from any list.
 *
 * WHY THIS SCREEN EXISTS BESIDE `/lists/:listId/review`. The daily nudge picks
 * the three words that need the most work, and it picks them across ALL of a
 * person's lists, so there is no single list id to hang the session off. The
 * ids go in the URL rather than into a stashed "session seed" in the store,
 * because the URL is the state React Router already keeps for a screen: a
 * reload replays the same three, and there is no half-written row to clean up
 * when the reader closes the tab instead.
 *
 * CLIENT ONLY, like every screen that reads saved words. The ids are opaque
 * local identifiers and never reach the server, which could not resolve them
 * anyway. The service worker never caches a URL carrying a query string, so a
 * HARD reload here while offline lands on `/offline`; the in-app tap from the
 * nudge, which is how a reader gets here, works with the network off.
 *
 * An id that names nothing is simply dropped. A word deleted between the nudge
 * rendering and the reader tapping it is the ordinary way to reach that, and
 * the honest response is a session over what is left, not an error page.
 */
export async function clientLoader({ request }: Route.ClientLoaderArgs) {
  const ids = parseEntryIds(request.url);
  if (ids.length === 0) return { cards: [] };

  const byId = new Map((await listLocalListItems()).map((item) => [item.id, item]));
  const cards: ReviewCard[] = ids
    .map((id) => byId.get(id))
    .filter((item) => item !== undefined)
    .map((item) => ({
      id: item.id,
      lemma: item.lemma,
      translation: item.translationSnapshot,
      note: item.note,
    }));

  return { cards };
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

export default function DailyReviewRoute({ loaderData }: Route.ComponentProps) {
  const { t } = useTranslation();
  const { cards } = loaderData;

  if (cards.length === 0) {
    return (
      <div className="surface-brand-soft mx-auto flex w-full max-w-md flex-col gap-2 rounded-xl border border-dashed p-6">
        <h2 className="font-display text-base font-semibold">{t('nudge.sessionEmptyTitle')}</h2>
        <p className="text-sm text-muted-foreground">{t('nudge.sessionEmptyBody')}</p>
        <Link to="/lists" className="text-sm text-primary hover:underline">
          {t('nudge.toLists')}
        </Link>
      </div>
    );
  }

  return (
    <ReviewSessionView
      cards={cards}
      heading={t('nudge.sessionHeading', { count: cards.length })}
      backTo="/"
      backLabel={t('nudge.backToSearch')}
    />
  );
}
