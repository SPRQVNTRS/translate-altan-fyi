/**
 * POST /api/v1/translate - Translate one word or one sentence.
 *
 * ONE ENDPOINT, BOTH SHAPES (M195 decision 9). The body carries text and a
 * direction, and nothing else decides the branch: the body has no `kind` field,
 * because `normalizeQuery(q, from).isPhrase` is the same call the search loader
 * makes and a caller who could state the branch could state the wrong one. The
 * answer carries which branch ran, and its shape does not depend on the answer.
 *
 * AUTHENTICATED BY AN API KEY, NOT BY A SESSION. The caller is a script or the
 * CLI, not a fetcher inside a rendered page, so the session-gated routes under
 * `/api/translation*` are the wrong model here. It is a plain `requireApiKey`
 * rather than a superadmin one: translating is the product's own verb, and any
 * legitimate key may ask for it.
 *
 * IT IS NOT A WAY PAST THE SPEND GUARDS. Every guard the screen applies lives
 * inside `resolveTranslateRequest`, which is the same function the DirectTransport
 * twin calls, so there is no path through this file that reaches a model without
 * passing them.
 */

import { z } from 'zod';

import type { Route } from './+types/api.v1.translate';
import { jsonError, parseJsonBody, requireApiKey } from '#app/lib/api-auth.server';
import { SERVED_LANGUAGES } from '#app/lib/dictionary/detect-language';
import { resolveTranslateRequest } from '#app/lib/translation/translate-request.server';
import { getRawDb } from '#drizzle/db';

/** A language this installation serves. Anything else is a 400, never a silent default. */
const languageSchema = z.enum(SERVED_LANGUAGES);

/**
 * The body `POST /api/v1/translate` accepts.
 *
 * `wait` DEFAULTS TO FALSE, so the endpoint answers with whatever is true now,
 * which for a first-time sentence is `translating`. A caller that wants the
 * finished answer asks for it, and pays for it in latency.
 */
const translateBodySchema = z
  .object({
    q: z.string().min(1),
    from: languageSchema,
    to: languageSchema,
    wait: z.boolean().default(false),
  })
  // A pair with one language on both sides would queue a run to translate a
  // word into its own language. The screen can never produce one, because
  // `detectLanguage` resolves the pair first, so an API caller must not be able
  // to either.
  .refine((body) => body.from !== body.to, { message: 'from and to must be different languages' });

export async function action({ request }: Route.ActionArgs): Promise<Response> {
  if (request.method !== 'POST') {
    throw jsonError(405, 'method not allowed');
  }

  await requireApiKey(request);

  const body = await parseJsonBody(request, translateBodySchema);
  const answer = await resolveTranslateRequest(getRawDb(), {
    request,
    q: body.q,
    from: body.from,
    to: body.to,
    wait: body.wait,
  });

  return new Response(JSON.stringify(answer), {
    headers: { 'Content-Type': 'application/json' },
  });
}
