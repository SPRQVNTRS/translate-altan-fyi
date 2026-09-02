import { useTranslation } from 'react-i18next';
import { Link } from '#app/components/link';
import { licenceLabel, sourceRecordUrl } from '#app/lib/dictionary/source-urls';
import { cn } from '#app/lib/utils';

/**
 * The one source credit used by every dictionary surface.
 *
 * Attribution for a CC BY source is a licence obligation, not decoration, and
 * a source is named in three places: a search result row, a sense translation
 * or gloss, and an example sentence. The route to the attribution page is
 * therefore written down ONCE, here, and imported by all three. A copy per
 * consumer would be three places to miss when the route changes.
 *
 * WHAT THE CREDIT SAYS, AND WHY IT IS NOT THE ATTRIBUTION STRING
 *   The credit reads `<source name>, <licence>`, for example
 *   "Tatoeba, CC BY 2.0 FR". It is deliberately NOT the source's full
 *   attribution sentence. That sentence is a TEMPLATE for a single record: the
 *   Tatoeba one contains a literal `<id>` placeholder, which rendered on the
 *   entry page as the text "https://tatoeba.org/en/sentences/show/<id>". The
 *   full sentence, verbatim, belongs on the attribution page, which is one
 *   click away from every credit and is what the licence obligation points at.
 *
 * WHERE THE CREDIT LINKS
 *   When the row has an addressable record at the source, the credit itself is
 *   an external link to that record, because a reader who wants to check a
 *   sentence wants the sentence, not our page about the corpus. A second,
 *   quieter internal link then carries them to the attribution card. When there
 *   is no addressable record the credit is that internal link, and there is
 *   only one link on the line.
 */

/** Every source mention on every screen points at that source's card. */
export function attributionHref(sourceSlug: string): string {
  return `/attribution#${sourceSlug}`;
}

export interface SourceLinkProps {
  /** The slug that also serves as the anchor id on the attribution page. */
  sourceSlug: string;
  /** The source's display name, e.g. "Tatoeba". */
  sourceName: string;
  /** The source's SPDX-style licence id, e.g. "CC-BY-2.0-FR". */
  sourceLicence: string;
  /** The example's external id, when the row has one. Absent for glosses and translations. */
  externalId?: string | null;
  className?: string;
}

/** The shared link styling, so both links on the line read as one kind of thing. */
const LINK_CLASSES = 'underline-offset-2 hover:text-foreground hover:underline';

/** One source credit: who it came from, under what licence, and where to check it. */
export function SourceLink({ sourceSlug, sourceName, sourceLicence, externalId, className }: SourceLinkProps) {
  const { t } = useTranslation();

  const credit = `${sourceName}, ${licenceLabel(sourceLicence)}`;
  const recordUrl = sourceRecordUrl(sourceSlug, externalId ?? null);
  // One line, quiet, so a credit never competes with the sentence above it.
  const wrapperClasses = cn('inline-flex flex-wrap items-baseline gap-x-1 text-xs text-muted-foreground', className);

  if (recordUrl === null) {
    return (
      <span className={wrapperClasses}>
        <Link to={attributionHref(sourceSlug)} className={LINK_CLASSES}>
          {credit}
        </Link>
      </span>
    );
  }

  return (
    <span className={wrapperClasses}>
      {/* A plain anchor, not the app `Link`: this destination leaves the app, so
          there is no client-side route to transition to. The visible text is
          the bare credit, so the accessible name restores the sentence a screen
          reader needs to know what the link is crediting. */}
      <a
        href={recordUrl}
        target="_blank"
        rel="noreferrer"
        className={LINK_CLASSES}
        aria-label={t('entry.sourceLabel', { source: credit })}
      >
        {credit}
      </a>
      {/* A separator, not content: read aloud it would sit between two link
          names as a meaningless word. */}
      <span aria-hidden="true">&middot;</span>
      <Link to={attributionHref(sourceSlug)} className={cn(LINK_CLASSES, 'text-[11px]')}>
        {t('entry.sourceRecordLabel')}
      </Link>
    </span>
  );
}
