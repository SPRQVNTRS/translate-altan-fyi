import type { Route } from './+types/api.translation.$headwordId.retry';
import { isServedLanguage, type LanguageCode } from '#app/lib/dictionary/detect-language';
import { entryHeadwordQuery } from '#app/lib/dictionary/entry.server';
import { jsonError } from '#app/lib/api-auth.server';
import { createEntryLookups, resolveEntry } from '#app/lib/dictionary/queries.server';
import { resolveTriggeredTranslationPanel, type TranslationPanel } from '#app/lib/translation/panel.server';
import { authMiddleware } from '#app/middleware/auth';
import { getRawDb } from '#drizzle/db';

/**
 * `POST /api/translation/:headwordId/retry?to=<code>`, the retry button's half.
 *
 * IT GOES THROUGH THE SAME GATE THE SEARCH DOES, NOT A BARE JOB SEND.
 *   `resolveTriggeredTranslationPanel` runs the same three guards in the same
 *   order, and `retry: true` is the only difference: it steps over the failure
 *   the reader is looking at instead of returning it unchanged. A direct enqueue
 *   here would be a second, ungoverned way to spend money, reachable by anybody
 *   with a session and a headword id.
 *
 * THE RETRY WRITES A NEW RUN ROW, IT DOES NOT REWRITE THE FAILED ONE.
 *   `translation_runs` is append-only, and the pane reads the LATEST row, so a
 *   reader who retries twice before the first retry settles still reads a
 *   correct state rather than an ambiguous shared row.
 *
 * pg-boss DOES NOT BLOCK THE RE-ENQUEUE, AND THAT WAS MEASURED RATHER THAN
 * ASSUMED. The translation queue's policy is `stately`, whose unique index is
 * `(name, state, singleton_key) WHERE state <= 'active'`. A job that has failed
 * or completed is past `active` in that enum, so a send under the same singleton
 * key is accepted. Proven against the local database on 2026-09-05: a second
 * send while the first job was still `created` returned null (the dedupe firing),
 * and a send after the first job was moved to `failed` returned a fresh id. So
 * the singleton key stays as it is, without the run id in it, and the app-level
 * gate above is what stops a reader queueing two jobs for one failure.
 *
 * AN ACCOUNT IS REQUIRED, THROUGH THE SAME MIDDLEWARE THE GATED SCREENS USE.
 *   `authMiddleware` answers a path under `/api/` with a 401 in JSON rather than
 *   a redirect to a sign-in page, which is the only refusal a `fetch` can make
 *   sense of.
 */
export const middleware = [authMiddleware];

/** The answer for every id that names no servable headword. */
const NO_ENTRY_PANEL: TranslationPanel = { state: 'no-entry' };

export async function action({ params, request }: Route.ActionArgs): Promise<Response> {
  // A GET must not start work. The route has no loader, so a GET already 405s;
  // this guard covers the other verbs a form or a client could send.
  if (request.method !== 'POST') throw jsonError(405, 'method not allowed');

  const db = getRawDb();
  const url = new URL(request.url);
  const requestedTo = url.searchParams.get('to');
  const to: LanguageCode = isServedLanguage(requestedTo) ? requestedTo : 'en';

  const resolved = await resolveEntry(createEntryLookups(db), params.headwordId);
  if (resolved.kind !== 'found' || resolved.entity !== 'headword') {
    return Response.json(NO_ENTRY_PANEL);
  }

  const [headword] = await entryHeadwordQuery(db, resolved.id);
  if (!headword || !isServedLanguage(headword.languageCode)) {
    return Response.json(NO_ENTRY_PANEL);
  }

  const panel = await resolveTriggeredTranslationPanel(db, {
    headwordId: headword.headwordId,
    from: headword.languageCode,
    to,
    request,
    retry: true,
  });
  return Response.json(panel);
}
