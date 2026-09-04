/**
 * The sync triggers, and the one place in this feature that touches `window`.
 *
 * Four things start a sync, and no more: the scheduler starting, a session
 * being established, the tab regaining focus, and the browser coming back
 * online — plus a settled burst of local edits, which is a different thing and
 * is handled differently below.
 *
 * This module has no upstream counterpart, so it carries no provenance header.
 *
 * ── An empty outbox used to mean silence, and that was the bug ────────────
 *
 * Every trigger here once did the same thing: put an intent in the outbox and
 * ask the outbox to drain. That is correct for a WRITE and wrong for
 * everything else, because THE OUTBOX CARRIES WRITES. A device that has never
 * made a local edit has an empty outbox, `selectFlushableRecords` picks
 * nothing, and no cycle ever runs — so a second device signed into the same
 * account sat on "No lists yet" forever while the account's blob was sitting on
 * the server. A device with nothing to say still needs to listen.
 *
 * So the boot, session, `focus` and `online` triggers now run a CYCLE. A cycle
 * is not a push: `runSyncCycleForCurrentSession` pulls, merges, applies, and
 * pushes only when the merge contributed something
 * (`orchestrator.ts` skips the push when `payloadsEqual`), so running one on a
 * device with nothing to contribute costs a pull and no blob version.
 *
 * ── Why the outbox is still flushed first ────────────────────────────────
 *
 * The debounced local-write trigger keeps its outbox intent, because a failed
 * push has to be retried later, in order, with backoff, and the outbox state
 * machine already does exactly that. So each trigger drains the queue first,
 * in order, and then runs its own cycle. Both paths serialize on the SAME two
 * mechanisms and no third one is introduced: `flushOutboxOnce` is already
 * single-flight, and `runSyncCycle` already takes `withSyncOrchestratorLock`.
 * When the flush has just run a cycle of its own, the trigger's cycle is a
 * pull that pushes nothing, which is cheaper than a third piece of state
 * deciding whether it was needed.
 */
import { reportError } from '#app/lib/report-error';
// THROUGH THE BARREL, NOT PAST IT. `#app/lib/local-store` is the one seam
// (`local-store-bridge.ts`'s header states the rule), and reaching into
// `persist.ts` is how a parallel writer ends up bypassing the save lock. The
// handle is taken here to SUBSCRIBE to writes, never to perform one — every
// write this module causes still goes through the barrel's own functions, so
// `sync-lock.ts`'s ordering rule is untouched.
import {
  enqueueSyncIntent,
  flushOutboxOnce,
  getPrimaryStore,
  setOutboxRunner,
  type OutboxRunner,
} from '#app/lib/local-store';
import { isSyncRequestError } from '#app/lib/sync/sync-error';
import { runSyncCycleForCurrentSession } from './orchestrator';
import { getSyncSession, setSyncSessionListener } from './sync-session';

/** How long a burst of local edits is allowed to settle before a push. */
export const PUSH_DEBOUNCE_MS = 1_500;

/**
 * Carries one queued intent up, in the `{ ok, status }` shape
 * `classifyFlushOutcome` reads.
 *
 * A `SyncRequestError` carries the HTTP status, which is what makes a `401` an
 * auth stop and a `413` a permanent rejection rather than an endless retry. A
 * thrown network error never had one, so it reports `status: null` and is
 * treated as transient.
 *
 * A `null` result means the session went away between the enqueue and the
 * flush. That is reported as a RETRY rather than a success: the intent has not
 * been carried up, and removing it from the queue on the strength of nobody
 * having tried would silently drop the edit that queued it.
 *
 * AN UNREADABLE DOCUMENT IS REPORTED AS `400`, WHICH IS FATAL. A payload this
 * build cannot parse, a leftover from another shape of this app or one written
 * by a newer one, throws `invalid` with no HTTP status of its own, and a `null`
 * status would be classified as transient and retried eight times over several
 * minutes for something no retry can fix. `classifyFlushOutcome` treats `400`
 * as a permanent rejection, which parks the record as blocked and stops.
 */
const syncIntentRunner: OutboxRunner = async () => {
  try {
    const result = await runSyncCycleForCurrentSession();
    return { ok: result !== null, status: null };
  } catch (cause) {
    return { ok: false, status: statusForFlush(cause) };
  }
};

/** The status `classifyFlushOutcome` should judge this failure by. See {@link syncIntentRunner}. */
function statusForFlush(cause: unknown): number | null {
  if (!isSyncRequestError(cause)) return null;
  if (cause.kind === 'invalid') return cause.status ?? 400;
  return cause.status;
}

/**
 * One cycle, with its failures absorbed.
 *
 * A dropped connection is the ordinary case for a trigger — `focus` fires on a
 * tab that came back before the network did — so a transport failure is not
 * reported: the next trigger retries, and reporting every one of them would
 * bury the failures that mean something. Anything else is unexpected.
 */
async function runCycleAbsorbingTransport(): Promise<void> {
  try {
    await runSyncCycleForCurrentSession();
  } catch (cause) {
    if (isSyncRequestError(cause) && cause.kind === 'transport') return;
    reportError(cause, { operation: 'sync-scheduler', step: 'runCycle' });
  }
}

/**
 * Starts the sync triggers for this page. Returns a function that stops them.
 *
 * WITH NO SESSION THIS DOES NOTHING AT ALL, and that is the product rule, not
 * a guard: the app is anonymous by default, every screen reads the local store,
 * and a visitor who never signs up must never see a network request or a
 * prompt because of sync. The check is made at every TRIGGER rather than once
 * at start, because a session can appear mid-page when someone completes the
 * setup ceremony, and disappear again when they sign out.
 *
 * Nothing runs during SSR: without a `window` this returns a no-op and
 * subscribes to nothing.
 */
export function startSyncScheduler(): () => void {
  if (globalThis.window === undefined) return () => undefined;

  let isStopped = false;
  let pendingPush: ReturnType<typeof setTimeout> | null = null;
  let detachStoreListener: (() => void) | null = null;

  setOutboxRunner(syncIntentRunner);

  /** Queued writes first, in order, then the pull this trigger exists for. */
  const catchUp = async (): Promise<void> => {
    if (isStopped || getSyncSession() === null) return;
    await flushOutboxOnce();
    if (isStopped || getSyncSession() === null) return;
    await runCycleAbsorbingTransport();
  };

  const onTrigger = (): void => {
    // The store listener is attached here rather than once at start, because
    // a session can appear mid-page and opening the store before one exists is
    // what re-creates a just-deleted database. It returns immediately when
    // there is no session or one is already attached.
    void attachStoreListener();
    void catchUp();
  };

  const queueAndFlush = async (): Promise<void> => {
    if (isStopped || getSyncSession() === null) return;
    await enqueueSyncIntent({ clientId: crypto.randomUUID() });
    await flushOutboxOnce();
  };

  /**
   * One intent per SETTLED burst. Typing a note fires a store write per
   * keystroke; without the debounce each one would be its own queued cycle,
   * and each cycle rewrites the whole blob.
   */
  const onLocalWrite = (): void => {
    if (isStopped || getSyncSession() === null) return;
    if (pendingPush !== null) clearTimeout(pendingPush);
    pendingPush = setTimeout(() => {
      pendingPush = null;
      void queueAndFlush();
    }, PUSH_DEBOUNCE_MS);
  };

  /**
   * Subscribes to local writes, and OPENS THE DEVICE'S STORE to do it.
   *
   * IT REFUSES TO RUN WITHOUT A SESSION, and that is not a micro-optimisation.
   * Resolving the primary store CREATES `translate-primary` in IndexedDB and
   * starts a persister polling it once a second. Doing that for a signed-out
   * visitor put the database back moments after sign-out deleted it, and again
   * on every reload of the home page, which is what a browser walk found on
   * 2026-09-04. It also contradicts this module's own rule, stated above: with
   * no session the scheduler subscribes to nothing.
   *
   * It is called again from the session trigger, so a reader who signs in
   * mid-page gets the listener without a reload.
   */
  const attachStoreListener = async (): Promise<void> => {
    if (isStopped || getSyncSession() === null) return;
    // Already subscribed. The session trigger fires on every focus and every
    // session install, and a second listener would double every debounce.
    if (detachStoreListener !== null) return;

    try {
      const store = await getPrimaryStore();
      const listenerId = store.addTablesListener(onLocalWrite);
      // The store resolves asynchronously, so a caller that stopped the
      // scheduler, or signed out, in the meantime would otherwise be left
      // subscribed forever.
      if (isStopped || getSyncSession() === null) {
        store.delListener(listenerId);
        return;
      }
      detachStoreListener = (): void => void store.delListener(listenerId);
    } catch (cause) {
      // A browser with no IndexedDB cannot hold the store this listener would
      // watch. The focus and online triggers still work, so sync degrades to
      // manual rather than breaking the page.
      reportError(cause, { operation: 'sync-scheduler', step: 'attachStoreListener' });
    }
  };

  window.addEventListener('focus', onTrigger);
  window.addEventListener('online', onTrigger);
  // A session can appear mid-page: `_app.tsx` installs one as soon as the root
  // loader reports a signed-in reader, which is the navigation right after the
  // sign-in form posts. Listening here is what lets a second device show its
  // lists straight after it signs in, instead of waiting for the user to switch
  // tabs and come back. The notification carries NO session; this module reads
  // it back through `getSyncSession` like every other trigger.
  setSyncSessionListener(onTrigger);
  // Boot. It used to be a no-op, because a reload lost the in-memory data key
  // and the session was null a line later. The credential is a cookie now and
  // `_app.tsx` installs the session from the root loader's answer, so a reload
  // on a signed-in device pulls here rather than waiting for a focus event.
  onTrigger();

  return () => {
    isStopped = true;
    if (pendingPush !== null) clearTimeout(pendingPush);
    window.removeEventListener('focus', onTrigger);
    window.removeEventListener('online', onTrigger);
    setSyncSessionListener(null);
    detachStoreListener?.();
    detachStoreListener = null;
    setOutboxRunner(null);
  };
}
