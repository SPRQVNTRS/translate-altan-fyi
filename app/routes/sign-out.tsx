/**
 * `/sign-out`. A POST, and the only route in this app that deletes local data.
 *
 * ── Why it is POST only ───────────────────────────────────────────────────
 *
 * A GET that signs you out is a URL anybody can put in an image tag, and it is
 * also a URL a link prefetcher can visit. The loader here answers a GET with a
 * redirect to the home page and changes nothing; the action is the sign-out.
 *
 * ── The wipe, and why it is a `clientAction` ──────────────────────────────
 *
 * Sign-out has to leave the device empty, so the next person on a shared phone
 * does not open somebody else's vocabulary lists. The data lives in two
 * IndexedDB databases, which only the browser can delete, so the order has to
 * be driven from the client:
 *
 *   1. one sync attempt, so the last local edits reach the account,
 *   2. drop the sync session, so no trigger starts a cycle mid-wipe,
 *   3. stop the persisters and delete both databases (`wipeDeviceStore`),
 *   4. ask the service worker to drop its caches, because a cached `/account`
 *      document carries the previous reader's address,
 *   5. call the server action, which destroys the cookie and redirects.
 *
 * The server step is LAST on purpose. Step 1 needs the cookie the server is
 * about to destroy, and steps 3 and 4 must not be cut short by the redirect the
 * server answers with: `serverAction()` throws that redirect, so nothing after
 * it in this function would run.
 *
 * STEP 3 STOPS THE PERSISTERS BEFORE IT DELETES ANYTHING, and the order inside
 * it matters as much as the order out here: a delete with the auto-load poll
 * still running is undone by that poll a second later. `wipe.ts` carries the
 * full account.
 *
 * A FAILED SYNC DOES NOT BLOCK THE SIGN-OUT. Somebody on a train tapping sign
 * out must be signed out. The edits stay in the device's outbox until the
 * wipe removes it, which is the honest trade: the alternative is refusing to
 * sign out on a bad connection.
 */
import { redirect } from 'react-router';

import type { Route } from './+types/sign-out';
import { wipeDeviceStore } from '#app/lib/local-store';
import { clearSyncSession } from '#app/lib/sync/sync-session';
import { syncNow } from '#app/components/account/sync-client';
import { isSyncRequestError } from '#app/lib/sync/sync-error';
import { reportError } from '#app/lib/report-error';
import { destroyUserSession } from '#app/services/session.server';

/** A GET is not a sign-out. Nothing here changes anything. */
export function loader(): Response {
  return redirect('/');
}

export async function action({ request }: Route.ActionArgs): Promise<Response> {
  return redirect('/', { headers: { 'Set-Cookie': await destroyUserSession(request) } });
}

export async function clientAction({ serverAction }: Route.ClientActionArgs): Promise<Response> {
  await carryLastEditsUp();
  clearSyncSession();
  await wipeDeviceStore();
  clearServiceWorkerCaches();
  return serverAction();
}

/**
 * One last cycle, with every failure absorbed.
 *
 * Offline, an expired session and a server that is down all land here, and none
 * of them is a reason to keep somebody signed in. A transport failure is not
 * even reported: it is the ordinary case for a device being put away.
 */
async function carryLastEditsUp(): Promise<void> {
  try {
    await syncNow();
  } catch (cause) {
    // A dropped connection or an already-dead session is the ordinary case for
    // a device being put away, and reporting it would bury the failures that
    // mean something. Anything else is unexpected and is worth a line.
    if (isSyncRequestError(cause) && (cause.kind === 'transport' || cause.kind === 'unauthorized')) return;
    reportError(cause, { operation: 'sign-out', step: 'finalSync' });
  }
}

/**
 * Asks the service worker to empty its caches.
 *
 * `/account` is in the precached app shell, and its HTML carries the signed-in
 * address. Deleting the databases without this would leave that page readable
 * offline by the next person holding the phone.
 */
function clearServiceWorkerCaches(): void {
  globalThis.navigator?.serviceWorker?.controller?.postMessage({ type: 'CLEAR_CACHE' });
}
