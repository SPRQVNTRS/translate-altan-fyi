/**
 * The sync triggers, and the one place in this feature that touches `window`.
 *
 * Three things start a cycle, and no more: a settled burst of local edits, the
 * tab regaining focus, and the browser coming back online. Each of them does
 * the same thing — put ONE sync intent in the outbox and ask the outbox to
 * drain — so the ordering, the retry backoff and the single-flight guarantee
 * all live in `app/lib/local-store/outbox.ts` rather than being reimplemented
 * per trigger.
 *
 * This module has no upstream counterpart, so it carries no provenance header.
 *
 * ── Why the outbox and not a bare call ────────────────────────────────────
 *
 * A cycle that fails needs to be retried later, in order, without a second
 * cycle jumping ahead of it. That is exactly what the outbox state machine
 * already does for queued intents, and `flushOutboxOnce` is already
 * single-flight — so `focus` and `online` firing together share one run
 * instead of racing. Calling `runSyncCycle` straight from an event handler
 * would need all of that written again, worse.
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
import { isSyncRequestError } from '#app/lib/e2ee/client/sync-error';
import { runSyncCycleForCurrentSession } from './orchestrator';
import { getSyncSession } from './sync-session';

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
 */
const syncIntentRunner: OutboxRunner = async () => {
  try {
    const result = await runSyncCycleForCurrentSession();
    return { ok: result !== null, status: null };
  } catch (cause) {
    return { ok: false, status: isSyncRequestError(cause) ? cause.status : null };
  }
};

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

  const flush = (): void => {
    if (isStopped || getSyncSession() === null) return;
    void flushOutboxOnce();
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

  const attachStoreListener = async (): Promise<void> => {
    try {
      const store = await getPrimaryStore();
      const listenerId = store.addTablesListener(onLocalWrite);
      // The store resolves asynchronously, so a caller that stopped the
      // scheduler in the meantime would otherwise be left subscribed forever.
      if (isStopped) {
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

  window.addEventListener('focus', flush);
  window.addEventListener('online', flush);
  void attachStoreListener();

  return () => {
    isStopped = true;
    if (pendingPush !== null) clearTimeout(pendingPush);
    window.removeEventListener('focus', flush);
    window.removeEventListener('online', flush);
    detachStoreListener?.();
    setOutboxRunner(null);
  };
}
