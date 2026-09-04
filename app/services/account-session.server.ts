/**
 * THE ONE PLACE the browser session cookie and the opaque token model meet.
 *
 * `app/lib/e2ee/auth-handlers.ts` issues opaque `access`/`refresh` tokens.
 * Upstream (`openplate-sync`) those travel in an `Authorization: Bearer`
 * header from a native client, and PROTOCOL.md §4.1 says so in as many words:
 * "A bearer token in an `Authorization: Bearer <token>` header. **No cookies,
 * in either direction.**"
 *
 * THIS SERVICE IS THE ONE DEPLOYMENT WHERE THAT SENTENCE DOES NOT APPLY, and
 * the reason is worth stating rather than assuming:
 *
 *  - The client here is a browser on the SAME ORIGIN as the server. There is
 *    no cross-origin request to make, so the wide-open
 *    `Access-Control-Allow-Origin: *` that §4.1 pairs with "no ambient
 *    credential" buys nothing, and its cost — that the token must live
 *    somewhere JavaScript can read — is paid for no benefit.
 *  - A token in an httpOnly cookie CANNOT BE READ BY INJECTED SCRIPT. A token
 *    in `localStorage` can: one XSS on any page of this origin exfiltrates a
 *    30-day refresh token, and the user learns nothing. The cookie is signed
 *    and `httpOnly`, so the same XSS can act as the user for as long as the
 *    page is open but cannot carry the credential away.
 *  - `sameSite: 'lax'` plus React Router 8's own same-origin check is what
 *    replaces the CSRF property §4.1 gets from having no ambient credential.
 *    We do not add a second CSRF mechanism and we do not disable the
 *    framework's; `TRUST_PROXY` is set so the framework sees the browser's
 *    origin through Traefik rather than the proxy's (`.env.example`).
 *  - The upstream service could not make this trade. It serves clients on
 *    other origins — that is its entire purpose — and a cookie is unusable
 *    across origins without `Allow-Credentials`, which would hand every
 *    hostile page an ambient credential. Same-origin is what makes the cookie
 *    available at all, and it is a property of this deployment, not of the
 *    protocol.
 *
 * WHAT IS STORED. The session key is `'account'`, holding the id, the handle
 * and BOTH raw tokens. The tokens are in the cookie rather than in a
 * server-side table because the cookie IS the server-side handle: only the
 * SHA-256 digest of each token is persisted (`app/lib/e2ee/tokens.ts`), so a
 * dumped `account_tokens` table yields nothing replayable, and the cookie is
 * signed so a forged one does not unseal.
 *
 * WHAT IS NOT STORED. No passphrase, no auth-hash, no wrapped DEK, no
 * recovery code. Nothing in this file can decrypt anything, which is the same
 * property `auth-handlers.ts` holds and for the same reason.
 *
 * ON THE FIELD NAME `id`. `app/lib/votes/account-gate.server.ts` already reads
 * `session.get('account')?.id`, and `app/types/session.ts` already declares
 * `SessionAccount` with an `id`. This module writes that field rather than an
 * `accountId`, so the vote gate keeps working unchanged. The local variables
 * here say `accountId` because that is what the handler cores call it; the
 * COOKIE says `id`.
 */
import { redirect } from 'react-router';

import { createComponentLogger } from '#app/lib/logger';
import { createAuthContext } from '#app/lib/e2ee/e2ee-context.server';
import { resolveAccessToken, type AccountSummary, type SessionTokens } from '#app/lib/e2ee/auth-handlers';
import { sessionStorage } from '#app/services/session.server';
import type { SessionAccount } from '#app/types/session';

const log = createComponentLogger('AccountSession');

/** Where a signed-out visitor is sent when a route requires an account. */
export const ACCOUNT_LOGIN_PATH = '/sign-in';

/** The resolved caller. Deliberately minimal: everything else is a database read away. */
export interface AccountSessionValue {
  accountId: number;
  handle: string;
}

/**
 * The signed-in account, or `null`.
 *
 * IT NEVER THROWS AND IT NEVER REDIRECTS — the same contract
 * `app/lib/votes/account-gate.server.ts` documents, for the same reason: a
 * refusal has a different shape in every caller, and a cookie that fails to
 * unseal is a signed-out visitor rather than an outage. The usual causes are a
 * rotated `SESSION_SECRET` and a truncated cookie, and both should render a
 * signed-out page rather than a 500.
 *
 * Four different "no" answers collapse into one `null`: no cookie, no
 * `account` key, an access token the store does not know, and an access token
 * that is expired or revoked. `resolveAccessToken` already folds the last
 * three together on purpose.
 *
 * NO TRANSPARENT REFRESH HAPPENS HERE — see {@link refreshAccountSession}.
 *
 * @param request the incoming request, read only for its cookie header.
 * @returns the account id and handle, or `null` when nobody is signed in.
 */
export async function getAccountSession(request: Request): Promise<AccountSessionValue | null> {
  const stored = await readAccountCookie(request);
  if (stored === null) return null;

  try {
    const resolved = await resolveAccessToken(stored.accessToken, createAuthContext());
    if (resolved === null) return null;
    // The cookie's own id is not trusted over the token's. The token is the
    // credential; the id beside it is a convenience the client could have
    // edited if it ever got the chance to.
    return { accountId: resolved.accountId, handle: stored.handle };
  } catch (cause) {
    // A database that cannot be reached is an outage, but it is not this
    // function's outage to raise: every caller treats `null` as signed out and
    // the ones that must fail loudly hit the store themselves a line later.
    log.warn('Could not resolve an access token', {
      reason: cause instanceof Error ? cause.message : String(cause),
    });
    return null;
  }
}

/**
 * The sign-in name in the cookie, for the chrome to render, or `null`.
 *
 * IT VALIDATES NOTHING AND IT MUST NEVER GATE ANYTHING. Unlike
 * {@link getAccountSession} it does not resolve the access token, so it costs
 * no database round trip and it keeps answering while the database is down.
 * That is the right trade for a name in a header and the wrong one for a
 * decision: an expired session still renders its name here, and the first
 * gated screen the reader opens sends them to `/sign-in` as it always did.
 *
 * The cookie is signed, so the name cannot be forged, only stale.
 *
 * @param request the incoming request, read only for its cookie header.
 * @returns the stored handle, or `null` when the cookie carries no account.
 */
export async function readAccountHandleForDisplay(request: Request): Promise<string | null> {
  const stored = await readAccountCookie(request);
  return stored?.handle ?? null;
}

/**
 * The signed-in account, or a redirect to the sign-in page.
 *
 * ONLY FOR ACCOUNT-ONLY ROUTES. Search, lists, history and entry all work
 * signed out, and must keep working signed out: this service's public
 * dictionary is not behind the personal layer. Reach for
 * {@link getAccountSession} there.
 *
 * @param request the incoming request.
 * @returns the resolved account.
 * @throws a `redirect` Response to {@link ACCOUNT_LOGIN_PATH} when absent.
 */
export async function requireAccountSession(request: Request): Promise<AccountSessionValue> {
  const account = await getAccountSession(request);
  if (account === null) throw redirect(ACCOUNT_LOGIN_PATH);
  return account;
}

export interface CommitAccountSessionInput {
  /** Read for its existing cookie, so committing an account does not drop the other session keys. */
  request: Request;
  tokens: SessionTokens;
  account: AccountSummary;
}

/**
 * The `Set-Cookie` value that signs `account` in.
 *
 * TAKES THE REQUEST RATHER THAN A `Session`, deliberately. A caller holding a
 * `Session` it read earlier in the same handler would commit a snapshot, and
 * the one bug that shape produces — silently dropping a key another line of
 * the same handler wrote — is invisible until a user notices their toast or
 * their language preference vanishing on sign-in.
 *
 * @param input the request, the freshly minted pair, and the account summary.
 * @returns a `Set-Cookie` header value.
 */
export async function commitAccountSession(input: CommitAccountSessionInput): Promise<string> {
  const session = await sessionStorage.getSession(input.request.headers.get('cookie'));
  session.set('account', {
    id: input.account.id,
    handle: input.account.handle,
    accessToken: input.tokens.accessToken,
    refreshToken: input.tokens.refreshToken,
  });
  return sessionStorage.commitSession(session);
}

/**
 * The `Set-Cookie` value that signs the caller out.
 *
 * DESTROYS THE WHOLE COOKIE rather than deleting the `account` key. A sign-out
 * on a shared device should leave nothing behind, and every other key this
 * cookie carries is a preference that costs nothing to rebuild.
 *
 * @param request the incoming request.
 * @returns a `Set-Cookie` header value that expires the cookie.
 */
export async function destroyAccountSession(request: Request): Promise<string> {
  const session = await sessionStorage.getSession(request.headers.get('cookie'));
  return sessionStorage.destroySession(session);
}

/**
 * The refresh token in the cookie, for `POST /api/v1/auth/refresh` alone.
 *
 * TRANSPARENT REFRESH IS DELIBERATELY NOT IMPLEMENTED, and this exported
 * accessor is the shape that replaces it. The reasoning, because "we left it
 * out" is not an answer on its own:
 *
 *   `handleRefresh` treats an ALREADY-REVOKED refresh token as the reuse
 *   signal and revokes the whole family — PROTOCOL.md §4.2, and it is the
 *   correct response to a stolen token. React Router runs the loaders of every
 *   matched route IN PARALLEL. So the moment an access token expires, a single
 *   navigation fires N loaders, each of which calls `getAccountSession`, each
 *   of which sees a dead access token, and each of which presents THE SAME
 *   refresh token. The first rotates it; the rest present a token that is now
 *   revoked; the family is revoked; the user is signed out. Not rarely — on
 *   every navigation that straddles the 15-minute boundary.
 *
 *   Making it safe needs single-flight coordination across those parallel
 *   loaders plus a way for the winner's `Set-Cookie` to reach the browser,
 *   and in React Router 8 a header set in a nested loader is dropped unless
 *   the route exports a `headers` function (workspace memory
 *   `reference_rr7_data_headers_dropped`). A half-built version of that is
 *   worse than none: it looks like it works until it logs everybody out.
 *
 *   So rotation happens ONLY at `POST /api/v1/auth/refresh`, which the client
 *   calls once, deliberately, on a 401. One call, one presentation of the
 *   token, no race. Single-flight transparent refresh is owed follow-up work,
 *   not a gap nobody noticed.
 *
 * @param request the incoming request.
 * @returns the raw refresh token, or `null` when the cookie carries none.
 */
export async function refreshAccountSession(request: Request): Promise<string | null> {
  const stored = await readAccountCookie(request);
  return stored?.refreshToken ?? null;
}

/**
 * The raw `account` key, or `null` for anything unusable.
 *
 * The `try` is the whole point: `getSession` REJECTS on a cookie it cannot
 * unseal, and every caller in this module treats that as signed out.
 */
async function readAccountCookie(request: Request): Promise<SessionAccount | null> {
  try {
    const session = await sessionStorage.getSession(request.headers.get('cookie'));
    const account = session.get('account');
    if (!account?.accessToken || !account.refreshToken) return null;
    return account;
  } catch (cause) {
    log.warn('Could not read the session cookie', {
      reason: cause instanceof Error ? cause.message : String(cause),
    });
    return null;
  }
}
