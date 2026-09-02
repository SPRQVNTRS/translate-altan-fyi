import type { Route } from './+types/search';
import { useRef } from 'react';
import { Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Form, useNavigation, type MetaFunction } from 'react-router';
import { DirectionChip } from '#app/components/direction-chip';
import { RecordSearch } from '#app/components/personal/record-search';
import { SearchResults } from '#app/components/search-results';
import { Button } from '#app/components/ui/button';
import { Input } from '#app/components/ui/input';
import { VoiceInput } from '#app/components/voice-input';
import { metaLanguage, metaTitle } from '#app/i18n/meta-title';
import { resolveRequestLanguage } from '#app/i18n/language-prefs';
import { detectLanguage } from '#app/lib/dictionary/detect-language';
import { enqueueEnrichmentInBackground } from '#app/lib/enrichment/enqueue.server';
import type { TitleHandle } from '#app/lib/route-title';
import { searchHeadwords } from '#app/lib/dictionary/search.server';
import { PROMPT_VERSION } from '#app/prompts/enrichment/version';
import { getRawDb } from '#drizzle/tenant-db';

// `meta()` runs outside the React tree, so it has no `t`. It goes through the
// pure `meta-title` seam instead, which reads the language off the ROOT loader
// rather than the process-wide i18next singleton. See that module for why the
// singleton is a cross-request bug here.
export const meta: MetaFunction = ({ matches }) => {
  const language = metaLanguage(matches);
  return [
    { title: metaTitle(language, 'search.metaTitle') },
    { name: 'description', content: metaTitle(language, 'search.metaDescription') },
  ];
};

/**
 * The name of this screen, for the chrome's `h1`.
 *
 * Search lives at `/`, which the nav catalog does carry, but the same screen is
 * also reachable at `/search`, which it does not. The handle names it once for
 * both, and reuses the catalog's own label so the header and the sidebar can
 * never disagree.
 */
export const handle = { titleKey: 'nav.search' } satisfies TitleHandle;

/**
 * The search itself, from the URL.
 *
 * `q`, `from` and `to` are search parameters and nothing else, so a result page
 * is linkable, shareable and correct under the back button. There is no client
 * state here at all.
 *
 * The dictionary tables are GLOBAL, shared by every reader, so this reads
 * through `getRawDb()`. `tenantDb` would scope a public dictionary to an
 * organisation, which it does not belong to.
 */
export async function loader({ request }: Route.LoaderArgs) {
  const url = new URL(request.url);
  const q = (url.searchParams.get('q') ?? '').trim();
  const db = getRawDb();
  // The UI language comes from the request cookie, not from the i18next
  // singleton: that instance is process-wide and would leak one reader's
  // language into another reader's request.
  const uiLanguage = resolveRequestLanguage(request.headers.get('cookie'));
  const direction = await detectLanguage(db, {
    q,
    from: url.searchParams.get('from'),
    to: url.searchParams.get('to'),
    uiLanguage,
  });
  if (q === '') {
    return { q, direction, hits: [] };
  }
  // THE WHOLE POINT OF THE DETECTION. `direction.from` and `direction.to` go
  // into the QUERY, not only into the chip above it. Passing the raw URL
  // parameters here instead would produce a correct-looking direction label
  // sitting over results drawn from the wrong side of the dictionary.
  const hits = await searchHeadwords(db, { q, from: direction.from, to: direction.to });

  // THE TOP HIT ONLY, AND FIRE AND FORGET.
  //   Warming the whole result page would multiply the provider spend by ten
  //   for a reader who opens one word, and the top hit is the one they open.
  //   The call never awaits and never rejects, so the results render at
  //   dictionary speed whether or not a job was queued. Nothing on this screen
  //   changes: the warmed notes show up on the entry page the reader clicks
  //   through to.
  const topHit = hits[0];
  if (topHit) {
    enqueueEnrichmentInBackground({
      headwordId: topHit.headwordId,
      from: direction.from,
      to: direction.to,
      promptVersion: PROMPT_VERSION,
    });
  }

  return { q, direction, hits };
}

/**
 * The home screen. The hero card is the one `.surface-brand` on this screen, a
 * design rule, so nothing else here may carry the brand wash.
 */
export default function SearchRoute({ loaderData }: Route.ComponentProps) {
  const { t } = useTranslation();
  const { q, direction, hits } = loaderData;
  const navigation = useNavigation();
  const isSearching = navigation.state !== 'idle';
  // The voice control writes into THIS box and submits THIS form. It owns no
  // query state of its own, so a spoken word and a typed one reach the loader
  // by exactly the same route.
  const inputRef = useRef<HTMLInputElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  // A detected direction is a guess, so it is NOT pinned into the next
  // submission: retyping should let the guess change. A direction the reader
  // chose by flipping the chip IS pinned, because they asked for it.
  const isDirectionPinned = !direction.detected;

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-6">
      <div className="surface-brand rounded-2xl border p-5">
        {/* GET, so the query lands in the URL and the results page is a place
            rather than the outcome of a POST nobody can link to. */}
        <Form method="get" ref={formRef}>
          <label htmlFor="search-word" className="text-sm font-medium">
            {t('search.fieldLabel')}
          </label>
          <div className="mt-2 flex gap-2">
            <Input
              ref={inputRef}
              id="search-word"
              name="q"
              type="text"
              defaultValue={q}
              placeholder={t('search.placeholder')}
              autoComplete="off"
            />
            {isDirectionPinned && (
              <>
                <input type="hidden" name="from" value={direction.from} />
                <input type="hidden" name="to" value={direction.to} />
              </>
            )}
            {/* The label changes with the state, it does not just gain a
                spinner. A button that still reads "Search" while a search runs
                is telling the reader nothing happened. */}
            <Button type="submit" disabled={isSearching}>
              {isSearching && <Loader2 className="size-4 animate-spin" aria-hidden="true" />}
              {isSearching ? t('search.submitting') : t('search.submit')}
            </Button>
          </div>
          <VoiceInput
            className="mt-3"
            inputRef={inputRef}
            formRef={formRef}
            sourceLanguage={direction.from}
          />
        </Form>
        <p className="mt-3 text-sm text-muted-foreground">{t('search.note')}</p>
      </div>

      {q === '' && <p className="text-sm text-muted-foreground">{t('search.emptyPrompt')}</p>}

      {q !== '' && (
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="font-display text-base font-semibold">{t('search.resultsFor', { query: q })}</h2>
            <DirectionChip direction={direction} query={q} />
          </div>
          {hits.length > 0 && <SearchResults hits={hits} to={direction.to} />}
          {hits.length === 0 && <p className="text-sm text-muted-foreground">{t('search.noResults', { query: q })}</p>}
          {/* The history WRITE, and it renders nothing. It is here rather than
              in the loader because the loader runs on the server, which must
              never learn what anybody looked up. */}
          <RecordSearch
            query={q}
            from={direction.from}
            to={direction.to}
            headwordId={hits[0]?.headwordId ?? null}
          />
        </div>
      )}
    </div>
  );
}
