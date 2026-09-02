import { useTranslation } from 'react-i18next';
import { Link } from '#app/components/link';

/**
 * The one source credit used by every dictionary surface.
 *
 * Attribution for a CC BY source is a licence obligation, not decoration, and
 * a source is named in three places: a search result row, a sense translation
 * or gloss, and an example sentence. The route to the attribution page is
 * therefore written down ONCE, here, and imported by all three. A copy per
 * consumer would be three places to miss when the route changes.
 */

/** Every source mention on every screen points at that source's card. */
export function attributionHref(sourceSlug: string): string {
  return `/attribution#${sourceSlug}`;
}

export interface SourceLinkProps {
  /** The slug that also serves as the anchor id on the attribution page. */
  sourceSlug: string;
  /** The attribution string the licence requires us to display. */
  attribution: string;
  className?: string;
}

/** One source credit, linked to its card on the attribution page. */
export function SourceLink({ sourceSlug, attribution, className }: SourceLinkProps) {
  const { t } = useTranslation();

  return (
    <Link
      to={attributionHref(sourceSlug)}
      className={className ?? 'text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline'}
    >
      {t('entry.sourceLabel', { source: attribution })}
    </Link>
  );
}
