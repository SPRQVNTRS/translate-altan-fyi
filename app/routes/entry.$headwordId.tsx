import type { Route } from './+types/entry.$headwordId';
import { useTranslation } from 'react-i18next';
import { redirect, type MetaFunction } from 'react-router';
import { DirectionChip } from '#app/components/direction-chip';
import { EnrichmentSection } from '#app/components/enrichment-section';
import { EntryUnavailable } from '#app/components/entry-unavailable';
import { Link } from '#app/components/link';
import { SenseTabs } from '#app/components/sense-tabs';
import { SourceLink } from '#app/components/source-link';
import { metaLanguage, metaTitle } from '#app/i18n/meta-title';
import { resolveRequestLanguage } from '#app/i18n/language-prefs';
import { isServedLanguage, type Direction, type LanguageCode } from '#app/lib/dictionary/detect-language';
import { EXAMPLE_LIMIT, getEntry } from '#app/lib/dictionary/entry.server';
import { createEntryLookups, resolveEntry } from '#app/lib/dictionary/queries.server';
import { getRawDb } from '#drizzle/tenant-db';

export const meta: MetaFunction = ({ matches }) => {
  const language = metaLanguage(matches);
  return [
    { title: metaTitle(language, 'entry.metaTitle') },
    { name: 'description', content: metaTitle(language, 'entry.metaDescription') },
  ];
};

/**
 * One headword, with its senses and its examples.
 *
 * MISSING IS A 200, RETIRED IS A 302.
 *   Entry ids are permanent and public, so an old link, a typo or a
 *   hand-edited URL is an ordinary request, not an error. A retired id gets a
 *   real HTTP redirect, because the replacement is the canonical address and
 *   search engines and bookmarks should learn it. Everything else, an unknown
 *   id, an id that names a sense or a translation rather than a headword, or a
 *   headword whose rows are all unlicensed, renders a warm page at 200. None of
 *   them throws a 404.
 */
export async function loader({ params, request }: Route.LoaderArgs) {
  const db = getRawDb();
  const url = new URL(request.url);
  const uiLanguage = resolveRequestLanguage(request.headers.get('cookie'));
  const requestedTo = url.searchParams.get('to');
  // The reader's own language is the sensible default target, and it is always
  // one of the served four, but the guard is what makes that a fact rather than
  // an assumption that breaks when a fifth UI language is added.
  const fallbackTo: LanguageCode = isServedLanguage(uiLanguage) ? uiLanguage : 'en';
  const to: LanguageCode = isServedLanguage(requestedTo) ? requestedTo : fallbackTo;

  const resolved = await resolveEntry(createEntryLookups(db), params.headwordId);
  if (resolved.kind === 'redirect') {
    // The query string rides along, so a flipped direction survives the hop.
    return redirect(`/entry/${resolved.replacementId}${url.search}`);
  }
  if (resolved.kind !== 'found' || resolved.entity !== 'headword') {
    return { entry: null, examples: [], direction: null, to };
  }

  const entry = await getEntry(db, { headwordId: resolved.id, to });
  if (entry === null) {
    return { entry: null, examples: [], direction: null, to };
  }
  // Built here rather than in the component so the language code is NARROWED
  // by a real check instead of an assertion. An entry in a language outside the
  // served four simply gets no chip.
  const direction: Direction | null =
    isServedLanguage(entry.languageCode) ? { from: entry.languageCode, to, detected: false } : null;
  // The cap is applied HERE, not in the component. `EXAMPLE_LIMIT` is a value
  // from a `.server` module, and a value read by any route export other than
  // the loader pulls that whole module into the CLIENT bundle, which
  // `react-router build` rejects. Typecheck and the dev server both let it
  // through, so the production build is the only thing that catches it.
  return { entry, examples: entry.examples.slice(0, EXAMPLE_LIMIT), direction, to };
}

export default function EntryRoute({ loaderData }: Route.ComponentProps) {
  const { t } = useTranslation();
  const { entry, examples, direction, to } = loaderData;

  if (entry === null) {
    return (
      <div className="mx-auto flex w-full max-w-2xl flex-col gap-4">
        <EntryUnavailable />
        <Link to="/" className="text-sm text-primary hover:underline">
          {t('entry.backToSearch')}
        </Link>
      </div>
    );
  }

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-6">
      <article className="rounded-lg border bg-card p-4 shadow-sm sm:p-6">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-2">
          <h2 lang={entry.languageCode} className="font-display text-2xl font-semibold tracking-tight">
            {entry.lemma}
          </h2>
          {entry.pos !== null && <span className="text-sm text-muted-foreground">{entry.pos}</span>}
          <span className="rounded-full bg-primary/10 px-2 py-0.5 text-xs uppercase text-primary">
            {entry.languageCode}
          </span>
          {/* Flipping on an entry page points back at the search screen: asking
              this entry for translations into its own language would be a
              guaranteed empty panel. */}
          {direction !== null && (
            <DirectionChip direction={direction} query={entry.lemma} flipTo="/search" className="ml-auto" />
          )}
        </div>
        <div className="mt-4">
          <SenseTabs senses={entry.senses} to={to} />
        </div>
      </article>

      <section className="rounded-lg border bg-card p-4">
        <h2 className="text-[11px] font-semibold uppercase tracking-[0.11em] text-primary">
          {t('entry.examplesLabel')}
        </h2>
        {examples.length === 0 && <p className="mt-1 text-sm text-muted-foreground">{t('entry.noExamples')}</p>}
        {examples.length > 0 && (
          <ul className="mt-2 space-y-3">
            {examples.map((example) => (
              <li key={example.id} className="text-sm">
                <p lang={example.languageCode} className="text-base">
                  {example.text}
                </p>
                {example.translationText !== null && example.translationLanguageCode !== null && (
                  <p lang={example.translationLanguageCode} className="text-muted-foreground">
                    {example.translationText}
                  </p>
                )}
                <SourceLink sourceSlug={example.sourceSlug} attribution={example.attribution} />
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* `idle` for now: nothing is enriching this entry, and M171 is what makes
          the other two states reachable. */}
      <EnrichmentSection state="idle" />

      <Link to="/" className="text-sm text-primary hover:underline">
        {t('entry.backToSearch')}
      </Link>
    </div>
  );
}
