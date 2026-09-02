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
import { isBudgetExhausted } from '#app/lib/abuse/budget.server';
import { checkTriggerRateLimit } from '#app/lib/abuse/rate-limit.server';
import { enqueueEnrichmentInBackground } from '#app/lib/enrichment/enqueue.server';
import { resolveEnrichmentPanel, type EnrichmentPanel, type EnrichmentRefusal } from '#app/lib/enrichment/state.server';
import { requireVoterAccount } from '#app/lib/votes/account-gate.server';
import type { TitleHandle } from '#app/lib/route-title';
import { PROMPT_VERSION } from '#app/prompts/enrichment/version';
import { getRawDb } from '#drizzle/tenant-db';

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
 * The panel for a page that shows no entry at all, and for an entry in a
 * language this dictionary does not serve. Nothing is arriving in either case,
 * and nobody asked for it, which is exactly what `not-requested` says.
 */
const MISSING_ENTRY_PANEL: EnrichmentPanel = {
  state: 'idle',
  reason: 'not-requested',
  model: null,
  from: null,
  senses: [],
};

/**
 * Whether this panel is asking for work, and what happens if it is.
 *
 * A CACHE HIT IS NOT A TRIGGER. IT IS NEVER COUNTED AND NEVER REFUSED.
 *   A `ready` panel already holds every note the page will show. Nothing will be
 *   queued for it, no provider will be called, and it will cost nothing, so
 *   running it past the rate limiter would count a request that spends no money
 *   against a budget for requests that do. The honest majority of readers, the
 *   ones landing on words the dictionary has already enriched, would then be the
 *   ones who exhaust the limit and get turned away, while the script walking
 *   uncached words gets the same allowance either way. The limiter therefore
 *   sees ONLY the panels that would start real work.
 *
 * THE GUARDS ARE AWAITED, NOT FIRED BEHIND THE RESPONSE.
 *   The enqueue is fire and forget on purpose, because its answer changes
 *   nothing on the page. These two do the opposite: their whole job is to decide
 *   whether the enqueue happens at all, and a decision taken after the response
 *   has gone is not a decision.
 *
 * @returns the panel to render. A refusal returns the SAME panel with one field
 *   set: the entry above it is complete, the HTTP status is unchanged, and
 *   nothing throws.
 */
async function triggerEnrichment(
  request: Request,
  panel: EnrichmentPanel,
  key: { headwordId: string; from: LanguageCode | null; to: LanguageCode },
): Promise<EnrichmentPanel> {
  if (key.from === null) return panel;
  // An idle panel has nothing to ask for and a READY one is the cache hit above.
  if (panel.state === 'idle' || panel.state === 'ready') return panel;
  // A failed panel is retried only once its window has passed. Without that
  // check one provider outage pins the entry to "failed" forever, because the
  // loader would never queue for it again.
  if (panel.state === 'failed' && !panel.retryable) return panel;

  const working = { reason: null, model: panel.model, from: panel.from, senses: panel.senses };

  const refusal = await refuseTrigger(request);
  if (refusal !== null) {
    // A REFUSAL LEAVES THE STATE ALONE. Nothing was started, so a failed panel
    // is still failed and a pending one is still pending; the only new fact is
    // WHY no work is running, which is one line of copy inside one card.
    if (panel.state === 'failed') {
      return { ...working, state: 'failed', retryable: panel.retryable, refusal };
    }
    return { ...working, state: 'pending', refusal };
  }

  // FIRE AND FORGET. A loader NEVER awaits a provider: the dictionary rows are
  // already in hand, and holding the page open for a model call would trade a
  // fast entry page for a slow one on every first visit. The job runs behind the
  // response, and the panel polls the read-only companion route for its result.
  enqueueEnrichmentInBackground({
    headwordId: key.headwordId,
    from: key.from,
    to: key.to,
    promptVersion: PROMPT_VERSION,
  });

  // PENDING, EVEN WHEN THE PANEL WAS FAILED. The page must show the run it just
  // started, not the failure it is retrying past, or the reader would be told
  // the notes cannot be generated while a job to generate them is in flight.
  return { ...working, state: 'pending', refusal: null };
}

/**
 * Which guard turns this trigger away, or `null` when neither does.
 *
 * The rate limit runs first, because it is the cheaper question and it is the
 * one that describes THIS caller. The budget is an installation-wide fact, so
 * asking it first would let one visitor's flood be reported as everyone's cap.
 */
async function refuseTrigger(request: Request): Promise<EnrichmentRefusal | null> {
  const verdict = await checkTriggerRateLimit(request);
  if (!verdict.allowed) return 'rate-limited';
  if (await isBudgetExhausted()) return 'budget';
  return null;
}

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

  const resolvedPanel: EnrichmentPanel =
    from === null
      ? MISSING_ENTRY_PANEL
      : await resolveEnrichmentPanel(db, {
          headwordId: entry.headwordId,
          senseIds: entry.senses.map((sense) => sense.senseId),
          from,
          to,
          accountId,
        });

  const panel = await triggerEnrichment(request, resolvedPanel, {
    headwordId: entry.headwordId,
    from,
    to,
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
