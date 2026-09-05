import type { Route } from './+types/api.translation-phrase';
import { phraseKeyFromRequest, resolvePhrasePanel, type TranslationPanel } from '#app/lib/translation/phrase-panel.server';
import { authMiddleware } from '#app/middleware/auth';
import { getRawDb } from '#drizzle/db';

/**
 * `GET /api/translation-phrase?q=<text>&from=<code>&to=<code>`, where one typed
 * sentence stands, as JSON.
 *
 * IT NEVER ENQUEUES. THAT IS THE WHOLE POINT.
 *   The pane polls this route every three seconds while a run is open. A read
 *   that also queued work would charge a reader who waited a minute for twenty
 *   runs of one sentence. The queueing decision is taken once, in the search
 *   loader, and `resolvePhrasePanel` is deliberately free of it so both callers
 *   share one answer. The retry POST beside this one is the only other place a
 *   phrase run is ever started.
 *
 * IT NEEDS AN ACCOUNT, AND THAT IS WHERE IT DIFFERS FROM THE WORD POLL.
 *   `/api/translation/:headwordId` is public because it serves exactly what the
 *   entry page at the same id already serves anyone. There is no public surface
 *   that serves a translated sentence: an account is required for every search
 *   since M184, so an ungated read here would be a way to reach this
 *   installation's paid answers by typing the same sentence and never signing
 *   in. `authMiddleware` under `/api/` refuses with a 401 in JSON rather than a
 *   redirect a `fetch` could not act on.
 *
 * IT SITS BESIDE `/api/translation/`, NOT UNDER IT. As `/api/translation/phrase`
 * the `:headwordId` dynamic segment would swallow it and every poll would reach
 * the word loader instead, which is the same trap the two vote routes avoid.
 *
 * A QUERY THIS ROUTE CANNOT READ IS AN ORDINARY 200 CARRYING `no-entry`. A
 * polled URL can go stale, and a 404 would put an error in a browser console for
 * what is really "there is nothing at this address".
 */
export const middleware = [authMiddleware];

/** The answer for every request whose query names no text this route can fold. */
const NO_ENTRY_PANEL: TranslationPanel = { state: 'no-entry' };

export async function loader({ request }: Route.LoaderArgs): Promise<Response> {
  const key = phraseKeyFromRequest(new URL(request.url));
  if (key === null) return Response.json(NO_ENTRY_PANEL);

  const panel = await resolvePhrasePanel(getRawDb(), key);
  return Response.json(panel);
}
