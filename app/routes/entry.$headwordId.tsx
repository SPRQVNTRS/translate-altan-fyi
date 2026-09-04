import type { Route } from './+types/entry.$headwordId';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { redirect, type MetaFunction } from 'react-router';
import { z } from 'zod';
import { DirectionChip } from '#app/components/direction-chip';
import { EnrichmentSection } from '#app/components/enrichment-section';
import { EntryUnavailable } from '#app/components/entry-unavailable';
import { Link } from '#app/components/link';
import { AddToListSheet } from '#app/components/personal/add-to-list-sheet';
import { EntryNote } from '#app/components/personal/entry-note';
import { ExampleLanguageBadge } from '#app/components/search-results';
import { SenseTabs } from '#app/components/sense-tabs';
import { SourceLink } from '#app/components/source-link';
import { metaLanguage, metaTitle } from '#app/i18n/meta-title';
import { resolveRequestLanguage } from '#app/i18n/language-prefs';
import { isServedLanguage, type Direction, type LanguageCode } from '#app/lib/dictionary/detect-language';
import { EXAMPLE_LIMIT, getEntry } from '#app/lib/dictionary/entry.server';
import { createEntryLookups, resolveEntry } from '#app/lib/dictionary/queries.server';
import { MISSING_ENTRY_PANEL, resolveTriggeredPanel } from '#app/lib/enrichment/trigger.server';
import { requireVoterAccount } from '#app/lib/votes/account-gate.server';
import type { TitleHandle } from '#app/lib/route-title';
import { getRawDb } from '#drizzle/db';

export const meta: MetaFunction = ({ matches }) => {
  const language = metaLanguage(matches);
  return [
    { title: metaTitle(language, 'entry.metaTitle') },
    { name: 'description', content: metaTitle(language, 'entry.metaDescription') },
  ];
};

/**
 * The word itself is the name of this screen, for the chrome's `h1`.
 *
 * The loader's shape is PARSED here rather than trusted. `handle` is a static
 * module-level export, so it cannot import the loader's return type without
 * dragging a `.server` module into the client bundle, and a missing entry is an
 * ordinary 200 on this route. A shape that does not carry a lemma therefore
 * returns `null`, and the header falls back the way it did before.
 */
const EntryTitleSchema = z.object({ entry: z.object({ lemma: z.string() }).nullish() });

export const handle = {
  title: (data) => {
    const parsed = EntryTitleSchema.safeParse(data);
    if (!parsed.success) return null;
    return parsed.data.entry?.lemma ?? null;
  },
} satisfies TitleHandle;

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
    return { entry: null, examples: [], direction: null, to, panel: MISSING_ENTRY_PANEL };
  }

  const entry = await getEntry(db, { headwordId: resolved.id, to });
  if (entry === null) {
    return { entry: null, examples: [], direction: null, to, panel: MISSING_ENTRY_PANEL };
  }
  // Narrowed here rather than in the component, by a real check instead of an
  // assertion, and narrowed ONCE for the chip, the panel and the job payload.
  // Both the enrichment cache key and the job payload are keyed on a served
  // language, so an entry outside the served four gets no chip and no
  // enrichment rather than a row nothing could ever look up again.
  const from: LanguageCode | null = isServedLanguage(entry.languageCode) ? entry.languageCode : null;
  const direction: Direction | null = from === null ? null : { from, to, detected: false };

  // The reader's vote identity, resolved BEFORE the panel because the panel
  // carries "my vote" on every sense it returns. It is null for an anonymous
  // visitor, which is the default mode of this product, and a null account costs
  // the resolver no query at all.
  const accountId = await requireVoterAccount(request);

  // THE STATE MACHINE IS SHARED, NOT LOCAL. Resolving the cache and deciding
  // whether to start work both live in `#app/lib/enrichment/trigger.server`,
  // which the search screen's output pane calls with the same arguments for its
  // top hit. Two copies of these rules is how the two surfaces would come to
  // disagree about the same word in the same second.
  const panel = await resolveTriggeredPanel({
    db,
    request,
    headwordId: entry.headwordId,
    senseIds: entry.senses.map((sense) => sense.senseId),
    from,
    to,
    accountId,
  });

  // The cap is applied HERE, not in the component. `EXAMPLE_LIMIT` is a value
  // from a `.server` module, and a value read by any route export other than
  // the loader pulls that whole module into the CLIENT bundle, which
  // `react-router build` rejects. Typecheck and the dev server both let it
  // through, so the production build is the only thing that catches it.
  return { entry, examples: entry.examples.slice(0, EXAMPLE_LIMIT), direction, to, panel };
}

export default function EntryRoute({ loaderData }: Route.ComponentProps) {
  const { t } = useTranslation();
  const { entry, examples, direction, to, panel } = loaderData;
  // THE SELECTION LIVES HERE, NOT IN `SenseTabs`. The save button and the chips
  // have to agree about which meaning the reader chose, and two copies of that
  // answer eventually disagree. Null is still the starting value: nothing is
  // selected until the reader picks, which is the rule `sense-tabs.tsx` exists
  // to defend.
  const [selectedSenseId, setSelectedSenseId] = useState<string | null>(null);

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

  // With exactly one sense there is nothing to choose, so that sense IS the
  // effective selection and the snapshot comes from it. The SAVED `senseId`
  // stays null all the same: the reader picked nothing, and recording a pick
  // they never made would put a claim in their own data that is not true.
  const onlySense = entry.senses.length === 1 ? entry.senses[0] : undefined;
  const pickedSense = onlySense ?? entry.senses.find((sense) => sense.senseId === selectedSenseId);

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-6">
      <article className="rounded-lg border bg-card p-4 shadow-sm sm:p-6">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-2">
          {/* THE HEADWORD IS MONOSPACED, like every other place this app
              shows the word itself: the result rows, the correction offer, the
              translations in the notes panel below. The display face still
              carries the chrome, and the chrome's `h1` above this card is
              already this same word, set in it. */}
          <h2 lang={entry.languageCode} className="font-mono text-2xl font-semibold tracking-tight">
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
            <DirectionChip direction={direction} query={entry.lemma} flipTo="/translate" className="ml-auto" />
          )}
        </div>
        <div className="mt-4">
          <SenseTabs
            senses={entry.senses}
            to={to}
            selectedSenseId={selectedSenseId}
            onSelectSense={setSelectedSenseId}
          />
        </div>
        <div className="mt-4">
          <AddToListSheet
            headwordId={entry.headwordId}
            lemma={entry.lemma}
            senseId={onlySense ? null : selectedSenseId}
            translationSnapshot={pickedSense?.translations[0]?.lemma ?? ''}
            senseCount={entry.senses.length}
          />
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
                    {example.translationLanguageCode !== to && (
                      <ExampleLanguageBadge languageCode={example.translationLanguageCode} />
                    )}
                  </p>
                )}
                <SourceLink
                  sourceSlug={example.sourceSlug}
                  sourceName={example.sourceName}
                  sourceLicence={example.sourceLicence}
                  externalId={example.externalId}
                />
              </li>
            ))}
          </ul>
        )}
      </section>

      <EnrichmentSection panel={panel} headwordId={entry.headwordId} to={to} />

      <EntryNote headwordId={entry.headwordId} />

      <Link to="/" className="text-sm text-primary hover:underline">
        {t('entry.backToSearch')}
      </Link>
    </div>
  );
}
