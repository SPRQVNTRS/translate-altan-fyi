import type { Route } from './+types/favourites';
import { useTranslation } from 'react-i18next';
import type { MetaFunction } from 'react-router';
import { toast } from 'sonner';
import { z } from 'zod';
import { ConfirmAction } from '#app/components/confirm-action';
import { repeatSearchHref, SavedWordRow } from '#app/components/personal/saved-word-row';
import { Button } from '#app/components/ui/button';
import { Skeleton } from '#app/components/ui/skeleton';
import { metaLanguage, metaTitle } from '#app/i18n/meta-title';
import { listFavorites, removeFavorite } from '#app/lib/local-store';

export const meta: MetaFunction = ({ matches }) => {
  const language = metaLanguage(matches);
  return [
    { title: metaTitle(language, 'favourites.metaTitle') },
    { name: 'description', content: metaTitle(language, 'favourites.metaDescription') },
  ];
};

/**
 * The words this reader kept.
 *
 * A CLIENT LOADER, LIKE `/lists` AND `/history`, AND FOR THE FIRST OF THEIR TWO
 * REASONS. Favourites live in IndexedDB on this device. They SYNC, unlike the
 * search log, so the server does hold a copy of them inside the account's
 * document, but it holds it as one opaque payload that no loader takes apart:
 * the device is the only place these rows are readable as rows. A server loader
 * here would have nothing to read, and the screen would be blank with the
 * network off.
 *
 * EVERY WORD ON A ROW COMES OFF THE ROW ITSELF. `lemma` and
 * `translationSnapshot` were written when the star was tapped, so this screen
 * makes no dictionary query at all, which is what lets it render offline. It is
 * also why the answer shown here can differ from what the translator says
 * today: a snapshot is what the reader chose to keep, and re-running the
 * translation underneath them would be a different promise.
 */
export async function clientLoader() {
  const favorites = await listFavorites();
  return {
    favorites: favorites.map((favorite) => ({
      id: favorite.id,
      lemma: favorite.lemma,
      translationSnapshot: favorite.translationSnapshot,
      from: favorite.from,
      to: favorite.to,
      // Newest first once it is sorted below. `updatedAt` is not an ordering
      // authority for SYNC, and this is not sync: it is one device putting its
      // own rows in the order its own reader made them.
      updatedAt: favorite.updatedAt,
    })).toSorted((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id)),
  };
}

/** The device answers in a frame or two, so the wait is a shape, not a spinner. */
export function HydrateFallback() {
  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-6">
      <Skeleton className="h-40 w-full" />
    </div>
  );
}

const INTENT = { REMOVE: 'remove' } as const;

const favouritesFormSchema = z.object({ intent: z.literal(INTENT.REMOVE), id: z.string().min(1) });

/**
 * Gives one word back.
 *
 * A TOMBSTONE, not a hard delete, which is `removeFavorite`'s own decision and
 * not this screen's: another device may still be holding the live row, and only
 * a marked removal can outrank it.
 */
export async function clientAction({ request }: Route.ClientActionArgs) {
  const parsed = favouritesFormSchema.safeParse(Object.fromEntries(await request.formData()));
  if (!parsed.success) return { success: false, error: 'invalid-form' };
  await removeFavorite(parsed.data.id);
  return { success: true };
}

interface FavoriteView {
  id: string;
  lemma: string;
  translationSnapshot: string;
  from: string;
  to: string;
}

/**
 * One kept word, on the row both personal screens share.
 *
 * WHAT IS LOCAL TO THIS SCREEN IS THE REMOVAL, and it is handed to the row as
 * its trailing control rather than built into it: a recorded search has nothing
 * to give back one at a time, so a shared row that owned a remove button would
 * be owning half of one caller's screen.
 */
function FavoriteRow({ favorite }: { favorite: FavoriteView }) {
  const { t } = useTranslation();

  return (
    <SavedWordRow
      term={favorite.lemma}
      answer={favorite.translationSnapshot}
      from={favorite.from}
      to={favorite.to}
      href={repeatSearchHref({ term: favorite.lemma, from: favorite.from, to: favorite.to })}
      ariaLabel={t('favourites.repeat', { term: favorite.lemma })}
      trailing={
        <ConfirmAction
          trigger={
            <Button type="button" variant="ghost" size="sm" aria-label={t('favourites.removeLabel', { term: favorite.lemma })}>
              {t('favourites.removeTrigger')}
            </Button>
          }
          title={t('favourites.removeTitle')}
          description={t('favourites.removeBody')}
          confirmText={t('favourites.removeConfirm')}
          confirmPendingText={t('favourites.removePending')}
          cancelText={t('favourites.removeCancel')}
          confirmVariant="destructive"
          formData={{ intent: INTENT.REMOVE, id: favorite.id }}
          // `onSuccess` runs on the action's own answer, so a removal that
          // failed says nothing rather than claiming a word is gone.
          onSuccess={() => toast.success(t('favourites.removedToast'))}
        />
      }
    />
  );
}

export default function FavouritesRoute({ loaderData }: Route.ComponentProps) {
  const { t } = useTranslation();
  const { favorites } = loaderData;

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-6">
      {favorites.length === 0 && (
        <div className="surface-brand-soft rounded-xl border border-dashed p-6">
          <h2 className="font-display text-base font-semibold">{t('favourites.emptyTitle')}</h2>
          <p className="mt-2 text-sm text-muted-foreground">{t('favourites.emptyBody')}</p>
        </div>
      )}

      {favorites.length > 0 && (
        <ul className="rounded-lg border bg-card">
          {favorites.map((favorite) => (
            <FavoriteRow key={favorite.id} favorite={favorite} />
          ))}
        </ul>
      )}
    </div>
  );
}
