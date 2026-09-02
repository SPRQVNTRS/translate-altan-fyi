import { Fragment } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from '#app/components/link';
import { SourceLink } from '#app/components/source-link';
import type { LanguageCode } from '#app/lib/dictionary/detect-language';
import type { SearchHit, SearchHitExample } from '#app/lib/dictionary/search.server';

/**
 * How many examples a result row shows. A row is a summary, so it carries
 * enough to recognise the word and no more; the entry page shows the rest.
 */
const ROW_EXAMPLE_LIMIT = 2;

/** One example sentence under a result row, quiet, with its source credit. */
function ResultExample({ example }: { example: SearchHitExample }) {
  return (
    <li className="text-sm">
      <span lang={example.languageCode} className="text-muted-foreground">
        {example.text}
      </span>
      {example.translationText !== null && example.translationLanguageCode !== null && (
        <span lang={example.translationLanguageCode} className="text-muted-foreground/80">
          {' '}
          {example.translationText}
        </span>
      )}{' '}
      <SourceLink sourceSlug={example.sourceSlug} attribution={example.attribution} />
    </li>
  );
}

/** The target-language translations of one hit, comma separated. */
function ResultTranslations({ hit }: { hit: SearchHit }) {
  const { t } = useTranslation();

  if (hit.translations.length > 0) {
    return (
      <p className="text-base">
        {hit.translations.map((translation, index) => (
          <Fragment key={`${translation.sourceSlug}:${translation.headwordId}`}>
            {index > 0 && ', '}
            <span lang={translation.languageCode}>{translation.lemma}</span>
          </Fragment>
        ))}
      </p>
    );
  }

  // A gloss is an explanation rather than a translation, so it is the second
  // choice, not an equal one. Saying so is cheaper than pretending.
  if (hit.gloss !== null) {
    return <p className="text-sm text-muted-foreground">{hit.gloss}</p>;
  }

  return <p className="text-sm text-muted-foreground">{t('search.noTranslationYet')}</p>;
}

/** One result row: the word, what it means, and a couple of examples. */
function ResultRow({ hit, to }: { hit: SearchHit; to: LanguageCode }) {
  const { t } = useTranslation();
  const examples = hit.examples.slice(0, ROW_EXAMPLE_LIMIT);

  return (
    <li className="rounded-lg border bg-card p-4 shadow-sm transition-all duration-200 hover:border-primary/40 hover:shadow-md">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        {/* The lemma is the link, not the whole card: the row also carries
            source links, and an anchor inside an anchor is invalid HTML. */}
        <Link
          to={`/entry/${hit.headwordId}?to=${to}`}
          lang={hit.languageCode}
          className="font-display text-lg font-semibold hover:text-primary"
        >
          {hit.lemma}
        </Link>
        {hit.pos !== null && <span className="text-xs text-muted-foreground">{hit.pos}</span>}
        {hit.matchKind === 'fuzzy' && (
          <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
            {t('search.matchFuzzy')}
          </span>
        )}
      </div>
      <div className="mt-1">
        <ResultTranslations hit={hit} />
      </div>
      {examples.length > 0 && (
        <div className="mt-3">
          <p className="text-[11px] font-semibold uppercase tracking-[0.11em] text-primary">
            {t('search.examplesLabel')}
          </p>
          <ul className="mt-1 space-y-1">
            {examples.map((example) => (
              <ResultExample key={example.id} example={example} />
            ))}
          </ul>
        </div>
      )}
    </li>
  );
}

export interface SearchResultsProps {
  hits: SearchHit[];
  /** The target language, carried into each entry link so the entry opens the same way round. */
  to: LanguageCode;
}

/** The result list. Empty and no-query states belong to the route, not here. */
export function SearchResults({ hits, to }: SearchResultsProps) {
  return (
    <ul className="flex flex-col gap-3">
      {hits.map((hit) => (
        <ResultRow key={hit.headwordId} hit={hit} to={to} />
      ))}
    </ul>
  );
}
