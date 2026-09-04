import type { Route } from './+types/api.enrichment.$headwordId';
import { isServedLanguage, type LanguageCode } from '#app/lib/dictionary/detect-language';
import { entryHeadwordQuery, entrySensesQuery } from '#app/lib/dictionary/entry.server';
import { createEntryLookups, resolveEntry } from '#app/lib/dictionary/queries.server';
import { resolveEnrichmentPanel, type EnrichmentPanel } from '#app/lib/enrichment/state.server';
import { getRawDb } from '#drizzle/db';

/**
 * `GET /api/enrichment/:headwordId?to=<code>`, the enrichment panel, as JSON.
 *
 * IT NEVER ENQUEUES. THAT IS THE WHOLE POINT.
 *   The entry page polls this route every few seconds while a job runs. If the
 *   read also queued work, a reader who waited a minute would pay for twenty
 *   runs of one enrichment. The queueing decision is taken once, in the entry
 *   loader, and `resolveEnrichmentPanel` is deliberately free of it so both
 *   callers can share the same answer.
 *
 * PUBLIC AND READ ONLY.
 *   No bearer token, unlike `/api/v1/*`. It serves exactly what the entry page
 *   at the same id already renders to anyone, so there is nothing here a
 *   session could gate.
 *
 * AN UNKNOWN HEADWORD IS AN ORDINARY 200.
 *   The entry route treats a missing id as a warm page rather than a 404, and a
 *   poll against one is no different: an idle panel says "nothing is arriving",
 *   which is exactly true.
 */

/** The answer for every id that names no servable headword. */
const IDLE_PANEL: EnrichmentPanel = {
  state: 'idle',
  reason: 'not-requested',
  model: null,
  from: null,
  senses: [],
};

export async function loader({ params, request }: Route.LoaderArgs): Promise<Response> {
  const db = getRawDb();
  const url = new URL(request.url);
  // English is the fallback rather than the reader's cookie language: this is a
  // polling companion to a page that already decided its target and puts it in
  // the query string, so an absent `to` means the caller lost it, not that a
  // preference should be guessed at a second time.
  const requestedTo = url.searchParams.get('to');
  const to: LanguageCode = isServedLanguage(requestedTo) ? requestedTo : 'en';

  // `resolveEntry` rather than a bare query: it carries the UUID guard, without
  // which a hand-typed id reaches a uuid comparison and Postgres answers with a
  // 500 for what is really a bad URL. A retired id resolves to `redirect` here
  // and gets the idle panel, because the entry loader has already sent the
  // browser to the replacement and this poll is against a stale address.
  const resolved = await resolveEntry(createEntryLookups(db), params.headwordId);
  if (resolved.kind !== 'found' || resolved.entity !== 'headword') {
    return Response.json(IDLE_PANEL);
  }

  // The headword row and its sense ids, not `getEntry`. The panel needs the
  // entry's language and its senses in page order, and nothing else; the
  // glosses, translations and examples `getEntry` also reads would be three
  // extra round trips per poll that nothing here would look at.
  const [headwordRows, senseRows] = await Promise.all([
    entryHeadwordQuery(db, resolved.id),
    entrySensesQuery(db, resolved.id),
  ]);
  const headword = headwordRows[0];
  if (!headword || !isServedLanguage(headword.languageCode)) {
    return Response.json(IDLE_PANEL);
  }

  const panel = await resolveEnrichmentPanel(db, {
    headwordId: headword.headwordId,
    senseIds: senseRows.map((row) => row.senseId),
    from: headword.languageCode,
    to,
  });
  return Response.json(panel);
}
