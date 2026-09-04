/**
 * Whether this page has a sync session, and whose.
 *
 * WHAT IT NO LONGER HOLDS. This module was the in-memory data-key vault: a
 * reload lost the key, and the pull-on-boot path had to unlock with the
 * passphrase before it could read anything. There is no key any more (M191),
 * so what is left is one small fact the client needs, the signed-in user id,
 * and the notification that says a session has appeared.
 *
 * THE COOKIE IS THE CREDENTIAL, NOT THIS VALUE. Every request the sync client
 * makes is `credentials: 'same-origin'` and is authorised by the server from
 * the cookie; the id here keys the device's own sync state and decides whether
 * a cycle is worth starting at all. A `null` means "do not sync", never "sync
 * anonymously".
 *
 * A MODULE SINGLETON, because there is exactly one signed-in user per page and
 * a second one would be a second answer to "whose data is this".
 */

/** What one signed-in session holds. */
export interface SyncSession {
  userId: number;
}

let current: SyncSession | null = null;

/**
 * Notified when a session is installed. One slot, installed by the scheduler,
 * mirroring `setOutboxRunner`.
 *
 * IT CARRIES NO SESSION, deliberately. The listener is told THAT a session
 * exists and reads it back through {@link getSyncSession} if it needs it. It
 * exists because a device that has just signed in should pull immediately
 * rather than wait for the user to switch tabs and come back.
 */
let sessionListener: (() => void) | null = null;

/** Installs (or with `null`, removes) the notification the scheduler runs when a session appears. */
export function setSyncSessionListener(listener: (() => void) | null): void {
  sessionListener = listener;
}

/** Installs the session the sync engine runs under. Called once the page knows who is signed in. */
export function setSyncSession(session: SyncSession): void {
  current = session;
  sessionListener?.();
}

/** The current session, or `null` when nobody is signed in on this page. */
export function getSyncSession(): SyncSession | null {
  return current;
}

/** Drops the session. Sign-out calls it, and so does a `401` from the sync endpoint. */
export function clearSyncSession(): void {
  current = null;
}
