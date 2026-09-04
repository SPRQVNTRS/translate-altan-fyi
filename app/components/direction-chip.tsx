import { useId } from 'react';
import { ArrowRight } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useLocation } from 'react-router';
import { Link } from '#app/components/link';
import { cn } from '#app/lib/utils';
import type { Direction } from '#app/lib/dictionary/detect-language';

export interface DirectionChipProps {
  /** The direction the current page is showing. */
  direction: Direction;
  /**
   * The query the flipped link should carry. On the search screen this is the
   * word that was typed; on an entry page it is the headword itself, so the
   * flip reads as "look this word up the other way round".
   */
  query: string;
  /**
   * Where the flipped link points. Defaults to the current path, which is the
   * search screen's case. An entry page passes `/translate`, because flipping
   * an entry in place would ask for translations into the entry's own
   * language.
   */
  flipTo?: string;
  className?: string;
}

/**
 * The direction of the lookup, as a tappable chip: `DE` arrow `EN`.
 *
 * It is a `Link`, never a `<button>` with client state. The URL is the single
 * source of truth for the direction, so a flip has to be a navigation: it works
 * with no JavaScript, it is bookmarkable, and the back button undoes it. A
 * button holding the direction in React state would disagree with the URL the
 * moment either one changed on its own.
 *
 * The arrow is a lucide glyph rather than a dash, both because a dash is not an
 * arrow and because an em dash is banned repo-wide.
 */
export function DirectionChip({ direction, query, flipTo, className }: DirectionChipProps) {
  const { t } = useTranslation();
  const location = useLocation();
  // Unique per instance: a hardcoded id would collide the moment a screen
  // carried two chips, and the second one's label would point at the first.
  const labelId = useId();
  const path = flipTo ?? location.pathname;
  // Built here rather than by the caller: the chip owns the meaning of "flip",
  // so a caller cannot hand it a link that swaps only the label.
  const flipped = new URLSearchParams();
  if (query !== '') flipped.set('q', query);
  flipped.set('from', direction.to);
  flipped.set('to', direction.from);

  return (
    <div className="flex items-center gap-2">
      {/* The group's name for assistive tech. Visible text would repeat what
          the two language codes already say to a sighted reader. */}
      <span className="sr-only" id={labelId}>
        {t('search.directionLabel')}
      </span>
      <Link
        to={`${path}?${flipped.toString()}`}
        aria-label={t('search.flipDirection')}
        aria-describedby={labelId}
        className={cn(
          'inline-flex items-center gap-1.5 rounded-full bg-primary/10 px-3 py-1 text-xs font-semibold uppercase tracking-wide text-primary transition-colors hover:bg-primary/20',
          className,
        )}
      >
        <span>{direction.from.toUpperCase()}</span>
        <ArrowRight className="size-3.5" aria-hidden="true" />
        <span>{direction.to.toUpperCase()}</span>
      </Link>
    </div>
  );
}
