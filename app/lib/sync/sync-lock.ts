/**
 * COPIED, NOT SHARED. Source: openplate/app/lib/sync/sync-lock.ts @ 68e893ac71d25ad7ff42280773ea0ec94f4f700e.
 * See .adr/0008-e2ee-sync-copied-not-extracted.md. Fixes belong upstream first,
 * then here. Do not let the two drift.
 */
/**
 * Cross-tab single-writer lock for the sync orchestrator.
 *
 * WHY IT EXISTS: three tabs open on the same device would otherwise run three
 * sync cycles concurrently. Two of them lose the CAS, re-pull, re-merge and
 * re-push — burning the 5-version retention window in seconds — and, worse,
 * any of them may spend the single-use refresh token that another is about to
 * spend, which the service reads as token THEFT and answers by revoking the
 * whole family (`PROTOCOL.md` section 4.2). Two honest tabs racing look
 * exactly like an attacker. One writer at a time removes both problems.
 *
 * ── The lock-ordering rule (read this before adding a second lock) ─────────
 *
 * `app/lib/local-store/persist.ts` already holds a Web Locks lock, named
 * `translate-local-store-save:<db>`, that serializes IndexedDB writes across
 * tabs. This one has a DIFFERENT NAME on purpose, and the two are acquired in
 * exactly ONE order:
 *
 *     orchestrator lock  ──►  (snapshot / apply)  ──►  persist.ts save lock
 *
 * The orchestrator takes its lock, then reads and writes the store through
 * `local-store`'s ordinary functions, which take the save lock internally and
 * release it. `persist.ts` never acquires the orchestrator lock, so the cycle
 * that would deadlock cannot be formed. Nothing in sync may ever take the save
 * lock first and then ask for this one — and nothing in sync should write to
 * IndexedDB by any path other than `local-store`'s own functions, which is
 * what keeps that guarantee checkable by reading the imports.
 *
 * ── Fallback ──────────────────────────────────────────────────────────────
 *
 * Without the Web Locks API (older Safari, `node:test`) this degrades to an
 * in-process promise chain: still correct within one tab, no longer
 * coordinated across tabs. `persist.ts` makes the same trade for the same
 * reason. The cost is a possible extra CAS round-trip, not corruption — the
 * compare-and-swap on the server is the real safety net, and it holds
 * regardless of what any client believes.
 */

/** Deliberately distinct from `persist.ts`'s `translate-local-store-save:` prefix. Never reuse that name. */
export const SYNC_ORCHESTRATOR_LOCK_NAME = 'translate-sync-orchestrator';

function canUseWebLocks(): boolean {
  return globalThis.navigator !== undefined && navigator.locks?.request !== undefined;
}

/** Serializes the fallback path within one JS context. Chained rather than pooled — sync cycles are rare and ordered. */
let fallbackChain: Promise<unknown> = Promise.resolve();

/**
 * Runs `task` as the device's only sync orchestrator.
 *
 * Waits for the lock rather than skipping: a "sync now" tap that silently did
 * nothing because another tab held the lock is indistinguishable from a broken
 * button. The debounced/boot callers are already idempotent, so waiting costs
 * at most a duplicated no-op cycle.
 */
export async function withSyncOrchestratorLock<T>(task: () => Promise<T>): Promise<T> {
  if (canUseWebLocks()) {
    // SAFETY: `LockManager.request` is typed `Promise<any>` because it forwards
    // whatever the callback returns; the callback here IS `task`, so what it
    // resolves with is exactly `T`.
    return navigator.locks.request(SYNC_ORCHESTRATOR_LOCK_NAME, task) as Promise<T>;
  }
  const run = fallbackChain.then(task, task);
  // Swallow on the CHAIN only — the returned promise still rejects for the
  // caller. Without this, one failed cycle would reject every future one.
  fallbackChain = run.catch(() => undefined);
  return run;
}
