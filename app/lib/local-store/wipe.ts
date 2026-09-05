/**
 * Removing this device's copy of the personal data.
 *
 * WHY THIS EXISTS AT ALL, WHEN THE GATE NEVER TOUCHES LOCAL DATA. Everywhere
 * else in this app the rule is the opposite one: a redirect, a refusal or an
 * expired session must never be the thing that deletes somebody's lists, and
 * `_app.gated.tsx` says so in as many words. Sign-out is the single exception,
 * and it is an exception because it is the one moment a PERSON says they are
 * done with this browser. A shared phone whose next reader sees the previous
 * reader's vocabulary lists, favourites or searches is the failure this closes.
 *
 * IT NEEDS NO ENTRY PER COLLECTION, AND THAT IS WHY IT IS SAFE TO ADD ONE. The
 * two databases go whole, so a new synced table such as `favorites` is carried
 * out by the same delete with no edit here. A version of this that cleared
 * named TABLES would have to be revisited for every collection ever added, and
 * the one somebody forgot is the one that survives a sign-out.
 *
 * ── The persisters are stopped FIRST, and that is the whole fix ───────────
 *
 * The first version of this file deleted the two databases and changed
 * nothing: the 2026-09-04 browser walk signed out and still found
 * `translate-primary` and `translate-outbox` in `indexedDB.databases()`. The
 * cause is not the delete. TinyBase's IndexedDB persister runs an AUTO-LOAD
 * POLL once a second, and each poll opens the database versionless, which
 * CREATES it when it is absent. So the delete succeeded and a poll re-created
 * an empty database a fraction of a second later. The same poll is what makes
 * a delete arrive `blocked` in the first place.
 *
 * So {@link closePersistedStores} runs before anything is deleted. With the
 * polls stopped there is nothing to re-create the databases and nothing
 * holding them open.
 *
 * ── It deletes the databases, not the rows ───────────────────────────────
 *
 * Clearing tables would leave the persister free to write them back, and would
 * leave the schema-version value and the device id in place. Dropping both
 * databases outright leaves the next boot in the state a brand new browser is
 * in, which is exactly the state that has to be reached.
 *
 * ── It never throws ──────────────────────────────────────────────────────
 *
 * A browser with no IndexedDB, a private window that refuses one, a delete
 * still blocked by a SECOND TAB this process cannot close: none of those is a
 * reason to leave the reader on a page that failed to sign them out. The
 * second-tab case is why the deadline exists, and it is the one case this
 * cannot fully win: another tab's poll can re-create the database after this
 * one gives up. Its own sign-out, or its own reload onto a signed-out page,
 * is what settles it.
 */
import { closePersistedStores } from './persist';
import { OUTBOX_DB_NAME, PRIMARY_DB_NAME } from './store';

/** How long a `deleteDatabase` blocked by another open tab is waited for before the sign-out continues. */
const DELETE_TIMEOUT_MS = 2_000;

/**
 * One delete request, reduced to what this module reads off it.
 *
 * NARROW ON PURPOSE. Naming `IDBOpenDBRequest` here would mean a test double
 * has to implement two dozen members none of this code touches, and the
 * double would then be an assertion chain rather than a value.
 */
export interface DeleteDatabaseRequest {
  addEventListener(type: string, listener: (event: { type: string }) => void): void;
}

/** The one method this module needs from `indexedDB`. The real `IDBFactory` satisfies it. */
export interface DatabaseDeleter {
  deleteDatabase(name: string): DeleteDatabaseRequest;
}

export interface WipeDeviceStoreOptions {
  /**
   * Stops every persister first. Injectable for ONE reason: without it a test
   * cannot prove the ordering, and the ordering is the entire defect this file
   * was rewritten to fix.
   */
  closeStores?: () => Promise<string[]>;
  /** The database registry, defaulting to the browser's. Injectable so a test needs no global to patch. */
  databases?: DatabaseDeleter | undefined;
}

/**
 * Stops the persisters and deletes both of this device's IndexedDB databases.
 *
 * @param options.closeStores the teardown step, defaulting to the real one.
 * @returns the names it managed to delete, so a caller or a test can see what
 *   actually happened rather than trusting a void.
 */
export async function wipeDeviceStore(options: WipeDeviceStoreOptions = {}): Promise<string[]> {
  const closeStores = options.closeStores ?? closePersistedStores;
  const databases = 'databases' in options ? options.databases : globalThis.indexedDB;

  // BEFORE the registry guard below, deliberately. Stopping the polls is worth
  // doing even in an environment where the delete then turns out to be
  // impossible, and it is what makes the delete possible where it is.
  await closeStores();

  if (databases === undefined) return [];
  const results = await Promise.all([
    deleteDatabase({ databases, name: PRIMARY_DB_NAME }),
    deleteDatabase({ databases, name: OUTBOX_DB_NAME }),
  ]);
  return results.filter((name) => name !== null);
}

/**
 * One database, with a deadline.
 *
 * `deleteDatabase` fires `blocked` while another connection is still open. With
 * this page's own persisters stopped that connection belongs to another TAB, so
 * the delete stays queued and completes when that tab lets go. `blocked` is
 * therefore NOT treated as a failure and does not settle the promise: the
 * deadline is what stops the wait, because a sign-out that hangs on a
 * forgotten second tab is worse than a device wiped a moment later.
 */
async function deleteDatabase({ databases, name }: { databases: DatabaseDeleter; name: string }): Promise<string | null> {
  try {
    return await Promise.race([deleteRequest({ databases, name }), timeoutAfter(DELETE_TIMEOUT_MS)]);
  } catch {
    return null;
  }
}

/** The request itself. One listener for both outcomes, so this promise has exactly one settle path. */
function deleteRequest({ databases, name }: { databases: DatabaseDeleter; name: string }): Promise<string | null> {
  return new Promise((resolve) => {
    const request = databases.deleteDatabase(name);
    const settle = (event: { type: string }): void => resolve(event.type === 'success' ? name : null);
    request.addEventListener('success', settle);
    request.addEventListener('error', settle);
  });
}

/** The deadline half of the race. */
function timeoutAfter(ms: number): Promise<null> {
  return new Promise((resolve) => {
    setTimeout(() => resolve(null), ms);
  });
}
