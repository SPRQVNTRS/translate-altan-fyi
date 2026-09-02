/**
 * `POST /api/v1/auth/signup` — create an account (PROTOCOL.md §5.8).
 *
 * On success this signs the browser in: the minted pair goes straight into the
 * httpOnly session cookie (`app/services/account-session.server.ts`), so the
 * client never holds a token in reachable script.
 *
 * THROTTLED BY IP ALONE. `throttle.ts`'s header states the rule and it is the
 * opposite of the login rule for a reason: signup has no pre-existing
 * identifier to protect, and keying the bucket by the SUBMITTED handle would
 * let an attacker rotate handles to mint a fresh allowance per attempt,
 * evading the limit entirely.
 *
 * THE `409` IS AN ACCEPTED ENUMERATION ORACLE, not a leak this route
 * introduces. It is the only one in the protocol, it is unavoidable on a
 * service with no address to write to, and the full argument is in
 * `handleSignup` and PROTOCOL.md §5.8. Nothing here widens it: every other
 * status this route can return is shared with an unrelated cause.
 */
import type { Route } from './+types/api.v1.auth.signup';

import { handleSignup } from '#app/lib/e2ee/auth-handlers';
import { createAuthContext } from '#app/lib/e2ee/e2ee-context.server';
import { commitAccountSession } from '#app/services/account-session.server';
import {
  methodNotAllowed,
  openThrottleGate,
  outcomeResponse,
  readJsonBody,
  sessionResponse,
} from '#app/lib/e2ee-http.server';

const ALLOWED_METHODS = ['POST'] as const;

export function loader(): Response {
  return methodNotAllowed(ALLOWED_METHODS);
}

export async function action({ request }: Route.ActionArgs): Promise<Response> {
  if (request.method !== 'POST') return methodNotAllowed(ALLOWED_METHODS);

  // No `identifier` — see the header. This is not an oversight and not symmetry
  // with the login route.
  const gate = openThrottleGate(request, { namespace: 'signup' });
  if (gate.lockedResponse) return gate.lockedResponse;

  const body = await readJsonBody(request);
  const outcome = await handleSignup(body, createAuthContext());

  if (outcome.status !== 'created') {
    gate.recordFailure();
    return outcomeResponse(outcome);
  }

  gate.clear();
  const setCookie = await commitAccountSession({
    request,
    tokens: outcome.body.tokens,
    account: outcome.body.account,
  });
  // `sessionResponse`, not `outcomeResponse`: the minted tokens go into the
  // cookie and NOT into the body. See its docblock.
  return sessionResponse(outcome, setCookie);
}
