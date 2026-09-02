/**
 * `POST /api/v1/auth/login` (PROTOCOL.md §5.9).
 *
 * NEVER TELLS THE CALLER WHICH HALF WAS WRONG. An unknown handle and a wrong
 * auth-hash both come back as the same `401` with the same body text, after
 * the same work: `handleLogin` computes the candidate verifier and compares it
 * against a full-width stand-in even when no account exists, so the branch that
 * returns is chosen AFTER the HMAC rather than instead of it. This route adds
 * no branch of its own — it maps one outcome onto one status, and every
 * failure here is that same outcome.
 *
 * THROTTLED PER IP AND HANDLE. Both, and the pair is the point. Per-IP alone
 * would let a single source grind one account from many addresses; per-handle
 * alone would be a free account-lockout DoS, in which anyone could bar a
 * stranger from their own diary by failing six logins against their handle.
 * Keying the bucket on both means an attacker on IP A locks
 * `A::victim-handle` and the real user on IP B hits an untouched bucket
 * (`throttle.ts`'s header).
 *
 * A `401` charges the bucket and a success clears it, exactly as §5.9
 * describes.
 */
import type { Route } from './+types/api.v1.auth.login';

import { handleLogin } from '#app/lib/e2ee/auth-handlers';
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

  // Read BEFORE the gate opens, because the bucket is keyed on the submitted
  // handle as well as the address.
  const body = await readJsonBody(request);
  const gate = openThrottleGate(request, { namespace: 'login', identifier: throttleIdentifier(body) });
  if (gate.lockedResponse) return gate.lockedResponse;

  const outcome = await handleLogin(body, createAuthContext());

  if (outcome.status !== 'ok') {
    gate.recordFailure();
    return outcomeResponse(outcome);
  }

  gate.clear();
  const setCookie = await commitAccountSession({
    request,
    tokens: outcome.body.tokens,
    account: outcome.body.account,
  });
  return sessionResponse(outcome, setCookie);
}
