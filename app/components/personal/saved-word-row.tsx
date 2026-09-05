import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from '#app/components/link';
import { LANGUAGE_NAMES } from '#app/lib/dictionary/language-pair';

/**
 * A language as the reader should see it named.
 *
 * NATIVE, AND NEVER TRANSLATED, which is `LANGUAGE_NAMES`'s own rule: a reader
 * finds their own language in a list they cannot otherwise read. A code that is
 * not served falls back to the code itself rather than to a lookup miss, which
 * a stored row from an older build could produce.
 */
function languageName(code: string): string {
  return Object.entries(LANGUAGE_NAMES).find(([served]) => served === code)?.[1] ?? code;
}

/**
 * The URL that runs this search again, direction included so the repeat is the
 * same search rather than a different one over the same word.
 */
export function repeatSearchHref({ term, from, to }: { term: string; from: string; to: string }): string {
  return `/translate?${new URLSearchParams({ q: term, from, to }).toString()}`;
}

export interface SavedWordRowProps {
  /** What the reader typed, or the word they kept. */
  term: string;
  /**
   * The answer that word got, or `null` when none was recorded.
   *
   * `null` renders the term alone. The alternative is an arrow pointing at
   * nothing, which reads as a lost answer rather than as a search whose answer
   * had not arrived when it was logged.
   */
  answer: string | null;
  from: string;
  to: string;
  /** Where the row leads: the same search, run again. */
  href: string;
  /** What a screen reader hears instead of the two lines, which are a fragment. */
  ariaLabel: string;
  /** What sits at the end of the row: an instant on history, a remove control on favourites. */
  trailing?: ReactNode;
}

/**
 * One saved word, on the two screens that list them.
 *
 * ONE COMPONENT FOR BOTH, and the reason is that both are answering the same
 * question. A favourite and a recorded search each name a term, the answer it
 * got, and the pair the answer was given in. Written twice, the arrangement
 * drifts: one screen gains the pair, the other keeps a bare word, and a reader
 * moving between the two has to learn the rows again.
 *
 * WHAT IS NOT SHARED IS WHAT DIFFERS. The relative time belongs to history,
 * because a favourite is not a moment, and the remove control belongs to
 * favourites, because a search log is cleared as a whole. Both arrive as
 * `trailing`, so this component decides where such a thing sits and never what
 * it is.
 *
 * THE TWO KEYS IT READS KEEP THEIR `favourites.` NAMES. They were written for
 * the screen that needed them first and they say exactly what this row says, so
 * renaming them would rewrite two catalogues to move a sentence that is not
 * changing. The catalogue is the wrong place to record which screen asked for a
 * key.
 *
 * EVERY WORD ON THE ROW COMES OFF THE ROW ITSELF. Both callers hold the term
 * and the answer on their own stored entity, so neither screen makes a
 * dictionary query and both render with the network off.
 */
export function SavedWordRow({ term, answer, from, to, href, ariaLabel, trailing }: SavedWordRowProps) {
  const { t } = useTranslation();

  return (
    <li className="border-b last:border-b-0">
      <div className="flex items-center gap-3 rounded-lg px-3 py-2 hover:bg-primary/5">
        <Link to={href} aria-label={ariaLabel} className="min-w-0 flex-1 hover:text-primary">
          {/* The word and the answer as ONE line, so the arrow between them is
              part of a translated sentence rather than a glyph this file
              invented. The pair sits under it, quieter, because it answers a
              question the reader only asks about rows they cannot place. */}
          <span className="block truncate text-sm font-medium">
            {answer === null ? term : t('favourites.rowSummary', { term, answer })}
          </span>
          <span className="block truncate text-xs text-muted-foreground">
            {t('favourites.pair', { from: languageName(from), to: languageName(to) })}
          </span>
        </Link>
        {trailing}
      </div>
    </li>
  );
}
