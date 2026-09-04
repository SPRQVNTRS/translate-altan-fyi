/**
 * The shapes the session cookie carries.
 */

/**
 * The signed-in account, as the cookie carries it. The only identity there is:
 * the starter base's `user` key went with the `users` table in M189.
 */
export interface SessionAccount {
  id: number;
  /** The opaque per-server identifier. Cosmetic here — the token beside it is the credential. */
  handle: string;
  /**
   * The raw opaque `access` token (`app/lib/e2ee/tokens.ts`), 15-minute TTL.
   *
   * IT IS SAFE HERE AND NOWHERE ELSE. This cookie is `httpOnly`, signed and
   * `sameSite: 'lax'`, so injected script cannot read it; the same string in
   * `localStorage` would be exfiltrable by one XSS. Only its SHA-256 digest is
   * persisted server-side, so a dumped `account_tokens` table replays nothing.
   * See `app/services/account-session.server.ts` for the full argument.
   */
  accessToken: string;
  /** The raw opaque `refresh` token, 30-day TTL and rotating. Spent only by `POST /api/v1/auth/refresh`. */
  refreshToken: string;
}

export interface SessionData {
  /** The signed-in account. A session without it is signed out. */
  account: SessionAccount;
}
