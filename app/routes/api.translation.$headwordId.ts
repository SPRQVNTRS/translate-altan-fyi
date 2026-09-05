import type { Route } from './+types/api.translation.$headwordId';
import { isServedLanguage, type LanguageCode } from '#app/lib/dictionary/detect-language';
import { entryHeadwordQuery } from '#app/lib/dictionary/entry.server';
import { createEntryLookups, resolveEntry } from '#app/lib/dictionary/queries.server';
import { resolveTranslationPanel, type TranslationPanel } from '#app/lib/translation/panel.server';
import { getRawDb } from '#drizzle/db';

/**
 * `GET /api/translation/:headwordId?to=<code>`, the translation panel, as JSON.
 *
 * IT NEVER ENQUEUES. THAT IS THE WHOLE POINT.
 *   The pane polls this route every three seconds while a run is open. A read
 *   that also queued work would charge a reader who waited a minute for twenty
 *   runs of one translation. The queueing decision is taken once, in the search
 *   loader, and `resolveTranslationPanel` is deliberately free of it so both
 *   callers share one answer. The retry route beside this one is the only other
 *   place a translation is ever started, and it is a POST behind an account.
 *
 * PUBLIC AND READ ONLY, like `api.enrichment.$headwordId.ts`. It serves the
 * rows the dictionary already serves to anyone at the same id, so there is
 * nothing here a session could gate. The route that STARTS work is gated; this
 * one only reports.
 *
 * AN UNKNOWN HEADWORD IS AN ORDINARY 200 CARRYING `no-entry`.
 *   A polled id can go stale, and a 404 on a poll would put an error in a
 *   browser console for what is really "there is nothing at this address", which
 *   is exactly what `no-entry` says.
 */

/** The answer for every id that names no servable headword. */
const NO_ENTRY_PANEL: TranslationPanel = { state: 'no-entry' };

export async function loader({ params, request }: Route.LoaderArgs): Promise<Response> {
  const db = getRawDb();
  const url = new URL(request.url);
  // English is the fallback rather than the reader's cookie language: this is a
  // polling companion to a page that already decided its target and put it in
  // the query string, so an absent `to` means the caller lost it, not that a
  // preference should be guessed at a second time.
  const requestedTo = url.searchParams.get('to');
  const to: LanguageCode = isServedLanguage(requestedTo) ? requestedTo : 'en';

  // `resolveEntry` rather than a bare query: it carries the UUID guard, without
  // which a hand-typed id reaches a uuid comparison and Postgres answers 500 for
  // what is really a bad URL.
  const resolved = await resolveEntry(createEntryLookups(db), params.headwordId);
  if (resolved.kind !== 'found' || resolved.entity !== 'headword') {
    return Response.json(NO_ENTRY_PANEL);
  }

  const [headword] = await entryHeadwordQuery(db, resolved.id);
  if (!headword || !isServedLanguage(headword.languageCode)) {
    return Response.json(NO_ENTRY_PANEL);
  }

  const panel = await resolveTranslationPanel(db, {
    headwordId: headword.headwordId,
    from: headword.languageCode,
    to,
  });
  return Response.json(panel);
}
