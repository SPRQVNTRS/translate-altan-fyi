/**
 * The shapes the session cookie carries.
 */

/**
 * The signed-in user, as the cookie carries it.
 *
 * TWO FIELDS, AND NO CREDENTIAL. The old cookie held a pair of opaque bearer
 * tokens, because authentication was a token family the client rotated. M191
 * replaced that with an ordinary server-side check: the cookie names WHO, the
 * middleware re-reads the row on every request, and there is nothing here that
 * could be replayed if the cookie leaked past its signature.
 */
export interface SessionUser {
  id: number;
  /**
   * When this session was issued, ISO-8601.
   *
   * IT IS THE SESSION'S AGE, AND IT IS LOAD-BEARING. `users.password_changed_at`
   * is the epoch every session is measured against: a cookie issued before the
   * current password was set is refused on its next request. That is how a
   * password change signs the other devices out with no session table to sweep.
   */
  issuedAt: string;
}

export interface SessionData {
  /** The signed-in user. A session without it is signed out. */
  user: SessionUser;
}
