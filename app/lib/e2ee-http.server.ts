/**
 * The HTTP glue under `app/routes/api.v1.auth.*` and
 * `app/routes/api.v1.sync.key-records.ts`: body decoding, the
 * `AuthOutcome` → status-code map, and the throttle wrapper.
 *
 * NOT under `app/lib/e2ee/`, on purpose. Everything in that directory is
 * COPIED from `openplate-sync` and carries a provenance header (ADR-0008);
 * this file has no upstream counterpart, because upstream the equivalent glue
 * is Express and this is React Router. Mixing it in there would make the
 * `git diff` that keeps the copy honest read as drift.
 *
 * IT HOLDS NO POLICY. Every decision — what is a 401, what a 409 means, which
 * failures are indistinguishable — was already taken in `auth-handlers.ts`
 * and is transcribed from PROTOCOL.md §4. This file maps a typed outcome onto
 * a status and nothing more, which is what lets the handler tests be the real
 * tests.
 *
 * RAW `Response`, NEVER `data()`. React Router 8 drops the headers of a
 * `data()` result unless the route also exports a `headers` function
 * (workspace memory `reference_rr7_data_headers_dropped`), and the header this
 * file most needs to survive is `Retry-After` on a 429. A raw `Response`
 * returned from a resource route reaches the wire unchanged, so the trap is
 * avoided by construction rather than by remembering to export something.
 */
import type { AccountSummary, AuthOutcome, SessionTokens } from '#app/lib/e2ee/auth-handlers';
import type { JsonValue } from '#app/lib/e2ee/json';
import { getThrottleStore } from '#app/lib/e2ee/e2ee-context.server';
import { throttleKey } from '#app/lib/e2ee/throttle';
import { clientIp } from '#app/lib/abuse/rate-limit.server';

/**
 * The bucket a request with no `X-Forwarded-For` falls into.
 *
 * Behind Traefik there is always one (`app/lib/abuse/rate-limit.server.ts`
 * documents the chain and the trust depth). A missing header therefore means
 * local development, where one shared bucket is the honest answer: it still
 * throttles, and it cannot be used to lock anyone out because nobody else is
 * on that address.
 */
const UNKNOWN_CLIENT_IP = 'unknown';

/** PROTOCOL.md §4: every non-2xx body is `{"error": "<human-readable text>"}`. */
export function errorResponse(status: number, message: string, headers?: HeadersInit): Response {
  return jsonResponse({ error: message }, status, headers);
}

/**
 * Serializes a domain value as a JSON response.
 *
 * Generic rather than `unknown`: the caller always knows the shape it is
 * sending — a `KeyRecordPayload`, an `{ error }` envelope, an
 * `AuthOutcome`'s body — and naming it here would only force every call site
 * through a cast. Nothing in this function inspects the value.
 */
export function jsonResponse<T>(body: T, status: number, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
  });
}

/**
 * Decodes a JSON request body.
 *
 * A body that is absent, empty or malformed becomes `undefined` rather than a
 * throw. Every field parser in `auth-input.ts` already rejects `undefined`
 * with a reason naming the field it wanted, which is a more useful `400` than
 * "body must be JSON" — and, on the login and recover paths, one that does not
 * distinguish a malformed body from a wrong credential by its shape.
 *
 * @param request the incoming request.
 * @returns the parsed body, or `undefined`.
 */
export async function readJsonBody(request: Request): Promise<JsonValue | undefined> {
  try {
    const text = await request.text();
    if (text.length === 0) return undefined;
    // SAFETY: `JSON.parse` can only ever return `null`, a boolean, a number, a
    // string, an array of those, or a plain object of those — that set IS
    // `JsonValue`, by the grammar of JSON. There is no input to `JSON.parse`
    // that produces a value outside it, so the assertion cannot be wrong. It
    // exists only because `JSON.parse` is typed `any` in the standard library.
    // Nothing downstream trusts the SHAPE: every field is decoded by
    // `app/lib/e2ee/auth-input.ts` before it is used.
    return JSON.parse(text) as JsonValue;
  } catch {
    return undefined;
  }
}

/**
 * Maps a handler outcome onto a response, per PROTOCOL.md §4.
 *
 * The `reason` strings are diagnostic only. They are safe to return verbatim
 * BECAUSE the handlers already collapsed every indistinguishable failure into
 * one shared constant before they got here: `LOGIN_REJECTED` for a wrong
 * handle and a wrong passphrase alike, `RECOVERY_REJECTED` for all four
 * recovery failures. This file must never invent a message of its own on
 * those paths, because that is exactly how the two halves of a credential
 * become distinguishable again.
 *
 * @param outcome the typed result from a handler core.
 * @param headers extra headers, used to carry `Set-Cookie` on the success paths.
 * @returns the response to return from the route.
 */
export function outcomeResponse<T>(outcome: AuthOutcome<T>, headers?: HeadersInit): Response {
  switch (outcome.status) {
    case 'ok':
      return jsonResponse(outcome.body, 200, headers);
    case 'created':
      return jsonResponse(outcome.body, 201, headers);
    case 'no-content':
      return new Response(null, { status: 204, headers });
    case 'invalid':
      return errorResponse(400, outcome.reason, headers);
    case 'unauthorized':
      return errorResponse(401, outcome.reason, headers);
    case 'forbidden':
      return errorResponse(403, outcome.reason, headers);
    case 'conflict':
      return errorResponse(409, outcome.reason, headers);
  }
}

/**
 * A session-issuing outcome, with the tokens moved OUT of the body and INTO
 * the cookie.
 *
 * THE TOKENS ARE DELIBERATELY NOT ECHOED. PROTOCOL.md's success bodies carry
 * `tokens` because upstream the caller is a native client that must hold them.
 * Here the caller is a browser, and the whole reason this bridge exists is that
 * a token in an httpOnly cookie cannot be read by injected script. Returning
 * the same token in the JSON body would hand it straight back to the script we
 * just took it away from, and the `httpOnly` flag would be decoration.
 *
 * What the caller gets instead is `{ account }` — the id, handle and display
 * name it needs to render "signed in as", and nothing that authenticates.
 * `POST /api/v1/auth/refresh` returns `204` for the same reason.
 *
 * @param outcome the handler outcome carrying `tokens` and, sometimes, `account`.
 * @param setCookie the `Set-Cookie` value produced by `commitAccountSession`.
 * @returns the response, with the tokens stripped from the body.
 */
export function sessionResponse(
  outcome: { status: 'ok' | 'created'; body: { tokens: SessionTokens; account?: AccountSummary } },
  setCookie: string,
): Response {
  const status = outcome.status === 'created' ? 201 : 200;
  const body = outcome.body.account === undefined ? {} : { account: outcome.body.account };
  return jsonResponse(body, status, { 'set-cookie': setCookie });
}

/** `405` for a method a resource route does not implement. `Allow` is what makes it actionable. */
export function methodNotAllowed(allowed: readonly string[]): Response {
  return errorResponse(405, `method not allowed; use ${allowed.join(', ')}`, { allow: allowed.join(', ') });
}

export interface ThrottleScope {
  /** Separates unrelated throttle domains sharing one store — `'login'`, `'recover'`, `'signup'`. */
  namespace: string;
  /**
   * The submitted account identifier, or `undefined` to key by IP alone.
   *
   * LOGIN AND RECOVER PASS THE HANDLE; SIGNUP MUST NOT. The rule is not
   * symmetry — it is stated in `throttle.ts`'s header and it points in
   * opposite directions on the two paths. On login, keying by (IP, handle)
   * stops one attacker on IP A locking the real user on IP B out of their own
   * account. On signup there is no pre-existing identifier to protect, and
   * keying by the SUBMITTED handle would let an attacker rotate handles to
   * mint a fresh allowance per attempt, evading the limit entirely.
   */
  identifier?: string;
}

export interface ThrottleGate {
  /** The response to return immediately, or `null` when the caller may proceed. */
  lockedResponse: Response | null;
  /** Charges one failed attempt against this bucket. */
  recordFailure(): void;
  /** Clears the bucket after a success. */
  clear(): void;
}

/**
 * Opens a throttle gate for one request.
 *
 * A lockout is surfaced as `429` with `Retry-After` in SECONDS, rounded up so
 * a client that obeys it never retries a millisecond early and earns a second
 * lockout for its trouble.
 *
 * @param request the incoming request, read for its forwarded address.
 * @param scope the throttle namespace and, where one exists, the submitted identifier.
 * @returns the gate: a response to return, plus the two state transitions.
 */
export function openThrottleGate(request: Request, scope: ThrottleScope): ThrottleGate {
  const store = getThrottleStore();
  const key = throttleKey({
    namespace: scope.namespace,
    ip: clientIp(request) ?? UNKNOWN_CLIENT_IP,
    identifier: scope.identifier,
  });

  const decision = store.check(key);
  const retryAfterSeconds = Math.max(1, Math.ceil(decision.retryAfterMs / 1000));

  return {
    lockedResponse: decision.locked
      ? errorResponse(429, 'too many attempts; try again later', {
          'retry-after': String(retryAfterSeconds),
        })
      : null,
    recordFailure: () => store.recordFailure(key),
    clear: () => store.clear(key),
  };
}

/**
 * The submitted handle, for throttle keying only.
 *
 * NOT a validation: `parseHandle` in `auth-input.ts` is what decides whether a
 * handle is acceptable, and it runs inside the handler. This only needs a
 * stable bucket label, so anything that is not a string becomes `undefined`
 * and the request falls back to the IP-only bucket rather than escaping the
 * throttle.
 *
 * @param body the decoded request body.
 * @returns the raw handle string, or `undefined`.
 */
export function throttleIdentifier(body: JsonValue | undefined): string | undefined {
  if (body === null || body === undefined || Array.isArray(body)) return undefined;
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- boundary read of an undecoded body; see the docblock.
  if (typeof body !== 'object') return undefined;
  const handle = body.handle;
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- boundary read of an undecoded body; see the docblock.
  return typeof handle === 'string' ? handle : undefined;
}
