/**
 * `POST /api/v1/auth/recover-rotate` — prove the recovery code, then set a new
 * passphrase (PROTOCOL.md §5.14).
 *
 * The proof travels in THIS request rather than in a session minted by
 * `recover`, so the code is checked in the same call that writes. A two-step
 * flow would let a session outlive the moment the user held the card.
 *
 * The whole submission is applied in ONE transaction by
 * `AccountStore.recoverAndRotatePassphrase`: the new verifier, the new KDF
 * descriptor, an optionally-new recovery verifier, the re-wrapped key records,
 * the revocation of every outstanding session and the caller's new pair. Every
 * half-state is a distinct disaster the user cannot see until they try to read
 * their own data. Nothing in this route may split that call.
 *
 * SHARES `recover`'s THROTTLE BUCKET, and does not clear it on success — the
 * two endpoints authenticate the same secret, so a separate allowance would
 * halve the cost of guessing it. Hence the `'recover'` namespace here.
 *
 * A ROTATION THAT LOST THE COMPARE-AND-SWAP RACE reports the SAME `401` a
 * wrong code does. `handleRecoverRotate` already collapses the two; this route
 * must not tell them apart, because a distinguishable race would signal that a
 * concurrent recovery just succeeded.
 */
import type { Route } from './+types/api.v1.auth.recover-rotate';

import { handleRecoverRotate } from '#app/lib/e2ee/auth-handlers';
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

  const outcome = await handleRecoverRotate(body, createAuthContext());

  if (outcome.status !== 'ok') {
    gate.recordFailure();
    return outcomeResponse(outcome);
  }

  const setCookie = await commitAccountSession({
    request,
    tokens: outcome.body.tokens,
    account: outcome.body.account,
  });
  return sessionResponse(outcome, setCookie);
}
