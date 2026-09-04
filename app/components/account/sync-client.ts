/**
 * The browser's three sync verbs: push what this device holds, pull what the
 * server holds, run one cycle.
 *
 * WHAT THIS FILE USED TO BE. Six hundred lines that derived an Argon2id key,
 * wrapped a data key under it, and drove four auth endpoints, because signing
 * in was a cryptographic ceremony rather than a form post. M191 replaced that
 * with a password and a session cookie: sign-in is a route action now
 * (`app/routes/sign-in.tsx`), and what is left here is the transport for the
 * one document a device syncs.
 *
 * NO CREDENTIAL CROSSES THIS MODULE. Every call is `credentials: 'same-origin'`
 * with no `Authorization` header, so the httpOnly cookie authorises it and no
 * token is reachable from script. A `401` means the session is over: the
 * session flag is cleared and the caller shows the sign-in nudge.
 */
import type { JsonValue } from '#app/lib/json';
import { runSyncCycleForCurrentSession, type SyncCycleResult } from '#app/lib/sync/orchestrator';
import { createBrowserSyncHttpClient, type PulledBlob } from '#app/lib/sync/http-client';
import { clearSyncSession } from '#app/lib/sync/sync-session';
import { isSyncRequestError } from '#app/lib/sync/sync-error';

/**
 * The server's current document for the signed-in user.
 *
 * @returns the document, or `null` when this account has never pushed one.
 * @throws a `SyncRequestError` for anything other than a 404.
 */
export async function pullSnapshot(): Promise<PulledBlob | null> {
  return withSignedOutCheck(() => createBrowserSyncHttpClient().pullBlob());
}

/**
 * Writes a document, if this device is up to date.
 *
 * @param input.baseVersion the version this device last agreed with. `0` asserts it has never pushed.
 * @param input.payload the framed document.
 * @returns the accepted version, or the current one on a lost race.
 * @throws a `SyncRequestError` for anything that is not a conflict.
 */
export async function pushSnapshot(input: { baseVersion: number; payload: JsonValue }) {
  return withSignedOutCheck(() => createBrowserSyncHttpClient().pushBlob(input));
}

/**
 * One full sync cycle: read, pull, merge, push.
 *
 * @returns the cycle's result, or `null` when nobody is signed in on this page.
 */
export async function syncNow(): Promise<SyncCycleResult | null> {
  return withSignedOutCheck(() => runSyncCycleForCurrentSession());
}

/**
 * Runs a call and turns a `401` into a signed-out page.
 *
 * THE FLAG IS CLEARED BEFORE THE ERROR IS RETHROWN, so the scheduler stops
 * retrying a session the server has already ended. Every caller still sees the
 * error and decides what to show.
 */
async function withSignedOutCheck<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (cause) {
    if (isSyncRequestError(cause) && cause.kind === 'unauthorized') clearSyncSession();
    throw cause;
  }
}
