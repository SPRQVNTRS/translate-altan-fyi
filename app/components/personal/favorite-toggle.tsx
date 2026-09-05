import { useEffect, useState } from 'react';
import { Star } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useRouteLoaderData } from 'react-router';
import { Button } from '#app/components/ui/button';
import { favoriteId, isFavorite, putFavorite, removeFavorite } from '#app/lib/local-store';
import { reportError } from '#app/lib/report-error';

/**
 * One tap keeps a word, and one tap gives it back.
 *
 * IT IS THE CHEAP SAVE, AND `AddToListSheet` IS THE CONSIDERED ONE. That sheet
 * refuses to write until a word with several senses has one chosen, for the
 * reason `sense-tabs.tsx` states: a dictionary must not pick a meaning on the
 * reader's behalf. A star cannot ask that question, because a control that
 * opens a dialogue is not a one-tap control. So it saves the word AND THE
 * ANSWER ON SCREEN, at whatever meaning the screen was showing, and records no
 * sense it was not given. The two saves sit side by side on the entry page so
 * the difference is visible rather than explained.
 *
 * IT RENDERS NOTHING FOR A READER WITH NO ACCOUNT, and the reason is not
 * politeness. Reading the device's store OPENS `translate-primary` in IndexedDB
 * and starts a persister polling it, which puts the database back moments after
 * sign-out deleted it. A browser walk on 2026-09-04 caught exactly that with
 * `DailyNudge`, which is why that component is gated the same way. A signed-out
 * reader also has nowhere for a favourite to go: `/favourites` is behind the
 * account gate.
 *
 * THE SIGNED-IN SIGNAL COMES FROM THE ROOT LOADER, and it is a display
 * convenience rather than a gate, exactly as the sidebar's admin link is. The
 * data this writes never leaves the device, so nothing here authorises
 * anything; the value only decides whether the store is opened at all.
 *
 * THE DEVICE IS READ ONCE, ON MOUNT, and never again. A star is not a live
 * view of a table: the only thing that changes it while it is on screen is this
 * button, and it already knows what it just did. An effect that re-read the
 * store on every render would poll IndexedDB for an answer it is holding.
 */
export interface FavoriteToggleProps {
  headwordId: string;
  /** The sense the surface had chosen, or null when it had none to choose. */
  senseId: string | null;
  /** The word itself, stored so the favourites screen needs no dictionary read. */
  lemma: string;
  /** The answer as it reads right now, stored as a snapshot. */
  translationSnapshot: string;
  from: string;
  to: string;
}

/**
 * What this button knows about the word it is on.
 *
 * `pending` is its own state rather than a null boolean, and the distinction is
 * what keeps the button from lying on a first paint: an unread device is not
 * "not saved", and rendering an empty star for it would show a reader that
 * their own saved word is unsaved for as long as the read takes.
 */
type FavoriteState = 'pending' | 'saved' | 'unsaved';

export function FavoriteToggle({ headwordId, senseId, lemma, translationSnapshot, from, to }: FavoriteToggleProps) {
  const { t } = useTranslation();
  // `userId` is the account's own integer primary key, so the annotation says
  // `number`. It is read as a PRESENCE check and never as a credential: the
  // device store is opened for a reader who holds a session, and nothing here
  // authorises anything with the value.
  const rootData = useRouteLoaderData<{ userId: number | null }>('root');
  const isSignedIn = (rootData?.userId ?? null) !== null;
  const [state, setState] = useState<FavoriteState>('pending');
  const [isWriting, setIsWriting] = useState(false);

  useEffect(() => {
    if (!isSignedIn) return;
    let isCurrent = true;

    const read = async (): Promise<void> => {
      try {
        const saved = await isFavorite({ headwordId, senseId, to });
        if (isCurrent) setState(saved ? 'saved' : 'unsaved');
      } catch (cause) {
        reportError(cause, { scope: 'favorite-toggle-read' });
      }
    };

    void read();
    return () => {
      isCurrent = false;
    };
  }, [isSignedIn, headwordId, senseId, to]);

  // AFTER the hooks, never before: a component that returns early above a hook
  // changes the hook order between renders, which React refuses.
  if (!isSignedIn) return null;

  const isSaved = state === 'saved';

  const handleClick = (): void => {
    if (isWriting || state === 'pending') return;
    setIsWriting(true);

    const write = async (): Promise<void> => {
      try {
        if (isSaved) {
          await removeFavorite(favoriteId({ headwordId, senseId, to }));
          setState('unsaved');
        } else {
          await putFavorite({ headwordId, senseId, lemma, translationSnapshot, from, to });
          setState('saved');
        }
      } catch (cause) {
        // The state is left as it was, so the star goes on showing what the
        // device actually holds rather than what the tap intended.
        reportError(cause, { scope: 'favorite-toggle-write' });
      } finally {
        setIsWriting(false);
      }
    };

    void write();
  };

  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      // BOTH DIRECTIONS ARE NAMED, the way `EnrichmentVotes` names its two
      // buttons. `aria-pressed` carries the state, and the label says what the
      // press will do, so a screen reader hears the action rather than being
      // left to infer it from an icon it cannot see.
      aria-label={isSaved ? t('favourites.remove') : t('favourites.add')}
      aria-pressed={isSaved}
      disabled={isWriting || state === 'pending'}
      onClick={handleClick}
    >
      {/* The fill is the whole signal, so it is set on the icon rather than on
          the button: a ghost button that changed background would read as
          hover, which is a different thing entirely. */}
      <Star className={isSaved ? 'fill-current' : ''} aria-hidden="true" />
    </Button>
  );
}
