/**
 * The in-memory DEK vault: the one place a signed-in session's data key lives.
 *
 * ── The boundary, stated as a rule ────────────────────────────────────────
 *
 * The DEK lives in this module's variable for the lifetime of the page and
 * NOWHERE ELSE. It is never written to `localStorage`, `sessionStorage`,
 * IndexedDB, a cookie, a URL, a form field or a log line, and it is never
 * returned from a loader. Nothing in this module may be `JSON.stringify`-ed,
 * and no value that holds a {@link SyncSession} may be either.
 *
 * A RELOAD THEREFORE LOSES IT, and that is correct rather than a gap to close.
 * The server holds only the DEK wrapped under a key it cannot derive
 * (`PROTOCOL.md` section 3.1), so the only way back to a usable DEK is the
 * passphrase, run through Argon2id again. That is why the pull-on-boot path
 * has to unlock first, and why persisting the DEK "just for convenience" would
 * undo the whole design: a DEK at rest on the device is a DEK an attacker with
 * the device does not need the passphrase for.
 *
 * A MODULE SINGLETON, because there is exactly one signed-in account per page
 * and a second one would be a second answer to "whose data is this".
 */

/** What one signed-in session holds. `accountId` binds the envelope AAD; `dek` opens the blob. */
export interface SyncSession {
  accountId: number;
  dek: Uint8Array;
}

let current: SyncSession | null = null;

/** Installs the session the sync engine runs under. Called by the setup and login ceremonies, immediately after the DEK exists. */
export function setSyncSession(session: SyncSession): void {
  current = session;
}

/** The current session, or `null` when nobody has unlocked on this page. A `null` here means "do not sync", never "sync anonymously". */
export function getSyncSession(): SyncSession | null {
  return current;
}

/** Drops the session. Sign-out calls it; so should anything that invalidates the key material. */
export function clearSyncSession(): void {
  current = null;
}
