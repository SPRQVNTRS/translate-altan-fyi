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

/**
 * Notified when a session is installed. One slot, installed by the scheduler,
 * mirroring `setOutboxRunner`.
 *
 * IT CARRIES NO SESSION, deliberately. The listener is told THAT a session
 * exists and reads it back through {@link getSyncSession} if it needs it, so
 * this module keeps its rule that the DEK leaves by exactly one door.
 *
 * It exists because this is the only place that sees all three ways in — the
 * setup ceremony, the second-device sign-in and the unlock card — and a device
 * that has just been handed a key should pull immediately rather than wait for
 * the user to switch tabs and come back. The alternative was a trigger call
 * duplicated in three components, one of which would eventually be forgotten.
 */
let sessionListener: (() => void) | null = null;

/** Installs (or with `null`, removes) the notification the scheduler runs when a session appears. */
export function setSyncSessionListener(listener: (() => void) | null): void {
  sessionListener = listener;
}

/** Installs the session the sync engine runs under. Called by the setup and login ceremonies, immediately after the DEK exists. */
export function setSyncSession(session: SyncSession): void {
  current = session;
  sessionListener?.();
}

/** The current session, or `null` when nobody has unlocked on this page. A `null` here means "do not sync", never "sync anonymously". */
export function getSyncSession(): SyncSession | null {
  return current;
}

/** Drops the session. Sign-out calls it; so should anything that invalidates the key material. */
export function clearSyncSession(): void {
  current = null;
}
