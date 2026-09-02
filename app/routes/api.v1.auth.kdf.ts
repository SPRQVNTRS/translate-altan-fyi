/**
 * `POST /api/v1/auth/kdf` — the pre-login KDF descriptor (PROTOCOL.md §5.7).
 *
 * Unauthenticated by necessity: a zero-knowledge login requires the client to
 * derive its auth-hash BEFORE it can authenticate, which requires the salt,
 * which requires an endpoint keyed by handle that answers before there is a
 * session.
 *
 * ALWAYS 200 FOR A WELL-FORMED HANDLE. A known handle gets its real
 * descriptor; an unknown one gets the deterministic dummy. Never a 404, never
 * an empty body, never a different shape. `handleGetKdfDescriptor` derives the
 * dummy UNCONDITIONALLY — including for accounts that exist and will never use
 * it — so a hit and a miss cost the same lookup and the same HMAC; this route
 * adds no branch of its own on top of that, because a branch here would
 * reintroduce the timing delta the handler pays an extra HMAC to remove. Read
 * `app/lib/e2ee/kdf-descriptor.ts`'s header for why the dummy exists at all.
 *
 * THROTTLED BY IP ALONE, and that is the second half of the same defence.
 * PROTOCOL.md §5.7 is explicit that keying this bucket by the submitted handle
 * would be WORSE THAN NOTHING: probing many handles *is* the attack, so a
 * per-handle bucket hands out a fresh allowance for every handle the attacker
 * wants to test. The residual timing signal is statistical and needs many
 * samples per handle; denying the samples is what closes it.
 *
 * POST, NOT GET, FOR WHAT IS A READ, and this is a deviation from the task as
 * briefed rather than an oversight. PROTOCOL.md §5.7 and
 * `auth-handlers.ts`'s own docblock both specify POST, with the same reason: a
 * GET puts the handle in the request line, and from there into access logs,
 * proxy logs, `Referer` headers and browser history. An endpoint whose entire
 * purpose is not disclosing who has an account must not scatter the identifier
 * it was asked about. A `GET` here gets a `405` naming the rule, so a client
 * that reaches for one fails loudly instead of leaking quietly.
 *
 * DO NOT "FIX" THIS BACK TO GET FOR REST TIDINESS. The choice was reviewed and
 * the contract was changed to match it: a handle in a query string lands in
 * the reverse-proxy access log, in browser history and in a `Referer` header,
 * and the handle is the ONLY identifying value this service holds. POST is the
 * settled shape; every client posts.
 */
import type { Route } from './+types/api.v1.auth.kdf';

import { handleGetKdfDescriptor } from '#app/lib/e2ee/auth-handlers';
import { createAuthContext } from '#app/lib/e2ee/e2ee-context.server';
import { asFields } from '#app/lib/e2ee/auth-input';
import { methodNotAllowed, openThrottleGate, outcomeResponse, readJsonBody } from '#app/lib/e2ee-http.server';

const ALLOWED_METHODS = ['POST'] as const;

export function loader(): Response {
  return methodNotAllowed(ALLOWED_METHODS);
}

export async function action({ request }: Route.ActionArgs): Promise<Response> {
  if (request.method !== 'POST') return methodNotAllowed(ALLOWED_METHODS);

  // Keyed by IP and NOT by the submitted handle — see the header.
  const gate = openThrottleGate(request, { namespace: 'kdf' });
  if (gate.lockedResponse) return gate.lockedResponse;

  const body = await readJsonBody(request);
  const outcome = await handleGetKdfDescriptor({ handle: asFields(body).handle }, createAuthContext());

  // A WELL-FORMED handle is charged; a malformed one (400) is not. The bucket
  // exists to bound ENUMERATION, and enumeration is done with well-formed
  // handles — those are the requests that reached a lookup. Charging only the
  // 400s would leave the attack untouched.
  if (outcome.status === 'ok') gate.recordFailure();

  return outcomeResponse(outcome);
}
