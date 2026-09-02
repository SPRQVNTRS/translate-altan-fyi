/**
 * `GET /api/v1/auth/account` — the caller's own summary.
 * `DELETE /api/v1/auth/account` — self-serve erasure (PROTOCOL.md §5.15).
 *
 * Both require a signed-in session. An absent or dead one is a `401`, never a
 * redirect: this is a JSON surface and a 302 to an HTML page is the wrong shape
 * for the fetch that called it.
 *
 * `DELETE` RE-AUTHENTICATES, even though the caller already holds a valid
 * session. A cookie left behind on a shared device must not be enough to
 * destroy someone's data irreversibly, so the body carries `{"authHash": ...}`
 * and `handleDeleteAccount` checks it against the stored verifier. There is no
 * soft delete and no grace period: the row goes, and every key record and vote
 * it owns goes with it by `ON DELETE CASCADE`, inside Postgres, with no
 * cleanup job that could be skipped.
 *
 * A DELETE WITH A REQUEST BODY, and a deviation from PROTOCOL.md §5.15, which
 * spells this endpoint `POST /v1/auth/delete`. The verb here is the one this
 * app's route table asked for; the SUBMISSION is unchanged, so a client posting
 * `{"authHash": ...}` speaks the same protocol either way. `fetch` sends a body
 * on `DELETE` without complaint. Recorded rather than silent, because the
 * protocol document is normative and this is a deliberate local difference.
 */
import type { Route } from './+types/api.v1.auth.account';

import { handleDeleteAccount, handleGetAccount } from '#app/lib/e2ee/auth-handlers';
import { createAuthContext } from '#app/lib/e2ee/e2ee-context.server';
import { destroyAccountSession, getAccountSession } from '#app/services/account-session.server';
import { errorResponse, methodNotAllowed, outcomeResponse, readJsonBody } from '#app/lib/e2ee-http.server';

const ALLOWED_METHODS = ['GET', 'DELETE'] as const;

/** The one `401` both verbs share. Never says whether the cookie was absent, expired or revoked. */
const NOT_SIGNED_IN = 'unauthorized: sign in to use this account';

export async function loader({ request }: Route.LoaderArgs): Promise<Response> {
  const session = await getAccountSession(request);
  if (session === null) return errorResponse(401, NOT_SIGNED_IN);

  return outcomeResponse(await handleGetAccount({ accountId: session.accountId }, createAuthContext()));
}

export async function action({ request }: Route.ActionArgs): Promise<Response> {
  if (request.method !== 'DELETE') return methodNotAllowed(ALLOWED_METHODS);

  const session = await getAccountSession(request);
  if (session === null) return errorResponse(401, NOT_SIGNED_IN);

  const body = await readJsonBody(request);
  const outcome = await handleDeleteAccount({ accountId: session.accountId, body }, createAuthContext());

  // The cookie is cleared only when the row actually went. A failed
  // re-authentication must leave the caller signed in — they mistyped a
  // passphrase, they did not ask to be logged out.
  if (outcome.status !== 'no-content') return outcomeResponse(outcome);

  return outcomeResponse(outcome, { 'set-cookie': await destroyAccountSession(request) });
}
