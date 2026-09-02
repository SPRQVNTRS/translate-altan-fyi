/**
 * `POST /api/v1/auth/recover` — sign in with the recovery code instead of the
 * passphrase (PROTOCOL.md §5.14).
 *
 * The recovery code is a SECOND AUTHENTICATOR, not a reset link. It replaced a
 * mailed link that, on a zero-knowledge service, restored a login to data that
 * stays sealed — an account-takeover path that bought no recovery. The code,
 * unlike the link, both authenticates AND unwraps, because the user holds it
 * and the server never has.
 *
 * FOUR CAUSES, ONE ANSWER. An unknown handle, an account that never set a
 * recovery code, and a wrong code all come back as the same `401` with the
 * same text, after the same work: `authenticateRecoveryCode` compares against
 * a full-width stand-in on every branch. This route must never add a message
 * of its own here.
 *
 * ONE THROTTLE BUCKET SHARED WITH `recover-rotate`, keyed per (IP, handle),
 * AND NEITHER CLEARS IT ON SUCCESS. Both endpoints authenticate the same
 * secret, so a separate allowance for each would halve the cost of guessing
 * it. A legitimate recovery happens once, so no honest client needs its
 * allowance back. The namespace below is therefore `'recover'` on both routes,
 * and the success path deliberately does not call `clear()`.
 */
import type { Route } from './+types/api.v1.auth.recover';

import { handleRecover } from '#app/lib/e2ee/auth-handlers';
import { createAuthContext } from '#app/lib/e2ee/e2ee-context.server';
import { commitAccountSession } from '#app/services/account-session.server';
import {
  methodNotAllowed,
  openThrottleGate,
  outcomeResponse,
  readJsonBody,
  sessionResponse,
  throttleIdentifier,
} from '#app/lib/e2ee-http.server';

const ALLOWED_METHODS = ['POST'] as const;

export function loader(): Response {
  return methodNotAllowed(ALLOWED_METHODS);
}

export async function action({ request }: Route.ActionArgs): Promise<Response> {
  if (request.method !== 'POST') return methodNotAllowed(ALLOWED_METHODS);

  const body = await readJsonBody(request);
  const gate = openThrottleGate(request, { namespace: 'recover', identifier: throttleIdentifier(body) });
  if (gate.lockedResponse) return gate.lockedResponse;

  const outcome = await handleRecover(body, createAuthContext());

  if (outcome.status !== 'ok') {
    gate.recordFailure();
    return outcomeResponse(outcome);
  }

  // No `gate.clear()`, deliberately — see the header.
  const setCookie = await commitAccountSession({
    request,
    tokens: outcome.body.tokens,
    account: outcome.body.account,
  });
  return sessionResponse(outcome, setCookie);
}
