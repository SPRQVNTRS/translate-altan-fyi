/**
 * Sign-out empties the device, and does it in the one order that works.
 *
 * THE DEFECT THIS EXISTS FOR. The first version of `wipeDeviceStore` called
 * `indexedDB.deleteDatabase` on both databases and nothing else. Every
 * assertion anybody thought to write about it passed, and the 2026-09-04
 * browser walk signed out and still found `translate-primary` and
 * `translate-outbox` in `indexedDB.databases()`. The delete was not the
 * problem: TinyBase's IndexedDB persister polls once a second, each poll opens
 * the database versionless, which CREATES it when absent, so the database came
 * back within a second of being removed.
 *
 * So the property under test is not "delete was called". It is:
 *
 *   1. the persisters are stopped BEFORE the first delete is issued, and
 *   2. both databases are deleted, and
 *   3. a delete that arrives `blocked` does not hang the sign-out.
 *
 * (1) is the one a weaker test misses, so it is asserted on the ORDER of a
 * recorded log rather than on the calls happening at all.
 *
 * BOTH SEAMS ARE INJECTED, and no global is patched. `wipeDeviceStore` takes
 * the registry it deletes from and the teardown it runs first, so this file
 * needs neither a DOM library nor a real IndexedDB, and it leaves nothing
 * behind for the next test file. What the fake gives up is real database
 * semantics; what it keeps is the only thing asked about here, which is what
 * the wipe does and in what order. The real browser check stays with the walk.
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { OUTBOX_DB_NAME, PRIMARY_DB_NAME } from '#app/lib/local-store/store';
import { wipeDeviceStore, type DatabaseDeleter } from '#app/lib/local-store/wipe';

/** How a faked delete request behaves. */
type DeleteOutcome = 'success' | 'error' | 'blocked-then-success' | 'blocked-forever';

/** One recorded step, so the ORDER of the whole wipe can be asserted. */
const log: string[] = [];

/**
 * A registry whose `deleteDatabase` answers however the case asks.
 *
 * The events fire asynchronously, the way a real request's do, so a listener
 * registered after the call still sees them. `blocked-forever` fires nothing
 * else, which is the second-tab case the deadline exists for.
 */
function fakeDatabases(outcomeByName: Map<string, DeleteOutcome> = new Map()): DatabaseDeleter {
  return {
    deleteDatabase(name: string) {
      log.push(`delete:${name}`);
      const listeners = new Map<string, (event: { type: string }) => void>();
      const fire = (type: string): void => listeners.get(type)?.({ type });
      const outcome = outcomeByName.get(name) ?? 'success';

      setTimeout(() => {
        if (outcome === 'blocked-forever') {
          fire('blocked');
          return;
        }
        if (outcome === 'blocked-then-success') {
          fire('blocked');
          setTimeout(() => fire('success'), 5);
          return;
        }
        fire(outcome);
      }, 1);

      return {
        addEventListener(type: string, listener: (event: { type: string }) => void) {
          listeners.set(type, listener);
        },
      };
    },
  };
}

/** Stand-in until the executor hands the real resolver over, one line later. */
function notReleasedYet(): void {}

/** The teardown step, recording that it ran. */
async function fakeCloseStores(): Promise<string[]> {
  log.push('close');
  return Promise.resolve([PRIMARY_DB_NAME, OUTBOX_DB_NAME]);
}

beforeEach(() => {
  log.length = 0;
});

describe('the sign-out wipe', () => {
  it('stops the persisters before it deletes anything', async () => {
    await wipeDeviceStore({ closeStores: fakeCloseStores, databases: fakeDatabases() });

    // THE ASSERTION THAT CATCHES THE REAL DEFECT. A wipe that deletes first is
    // undone by the auto-load poll a second later, and every other assertion
    // in this file still passes on that build.
    assert.equal(log[0], 'close', `the persisters were not stopped first: ${log.join(', ')}`);
    assert.ok(log.indexOf('close') < log.indexOf(`delete:${PRIMARY_DB_NAME}`));
    assert.ok(log.indexOf('close') < log.indexOf(`delete:${OUTBOX_DB_NAME}`));
  });

  it('deletes both databases and reports them', async () => {
    const deleted = await wipeDeviceStore({ closeStores: fakeCloseStores, databases: fakeDatabases() });

    assert.deepEqual(deleted.toSorted(), [PRIMARY_DB_NAME, OUTBOX_DB_NAME].toSorted());
    assert.deepEqual(log.toSorted(), ['close', `delete:${OUTBOX_DB_NAME}`, `delete:${PRIMARY_DB_NAME}`].toSorted());
  });

  it('waits out a delete that another tab blocked, then reports it', async () => {
    const databases = fakeDatabases(new Map([[PRIMARY_DB_NAME, 'blocked-then-success' as const]]));

    const deleted = await wipeDeviceStore({ closeStores: fakeCloseStores, databases });

    // `blocked` is not a failure: the delete stays queued and completes when
    // the other tab lets go. Settling on `blocked` would report a database as
    // surviving when it is about to be removed.
    assert.deepEqual(deleted.toSorted(), [PRIMARY_DB_NAME, OUTBOX_DB_NAME].toSorted());
  });

  it('reports a database it could not delete rather than claiming it', async () => {
    const databases = fakeDatabases(new Map([[OUTBOX_DB_NAME, 'error' as const]]));

    const deleted = await wipeDeviceStore({ closeStores: fakeCloseStores, databases });

    assert.deepEqual(deleted, [PRIMARY_DB_NAME]);
  });

  it('signs the reader out anyway when there is no database registry at all', async () => {
    // A private window, or a browser that refuses storage. The sign-out must
    // still finish.
    const deleted = await wipeDeviceStore({ closeStores: fakeCloseStores, databases: undefined });

    assert.deepEqual(deleted, []);
    // Stopping the persisters still ran. It is worth doing even where the
    // delete turns out to be impossible.
    assert.deepEqual(log, ['close']);
  });

  it('issues no delete until the close, and its in-flight autosave, have finished', async () => {
    // THE WALK'S SEQUENCE. A local write is mid-save at the moment sign-out is
    // clicked; the close has to wait for it, because destroying a persister on
    // top of its own running save throws inside TinyBase and leaves the delete
    // unissued. `closePersistedStores` is stood in for here by a teardown that
    // resolves late, which is what a real drain does.
    let releaseAutosave: () => void = notReleasedYet;
    const autosaveFinished = new Promise<void>((resolve) => {
      releaseAutosave = resolve;
    });

    const closeStores = async (): Promise<string[]> => {
      log.push('close:start');
      await autosaveFinished;
      log.push('close:end');
      return [PRIMARY_DB_NAME, OUTBOX_DB_NAME];
    };

    const wiped = wipeDeviceStore({ closeStores, databases: fakeDatabases() });

    // While the save is parked, NOTHING may be deleted.
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.deepEqual(log, ['close:start'], `a delete was issued during the close: ${log.join(', ')}`);

    releaseAutosave();
    const deleted = await wiped;

    // (a) no throw, (b) the close resolved after the autosave, (c) both
    // deletes came after the close.
    assert.deepEqual(deleted.toSorted(), [PRIMARY_DB_NAME, OUTBOX_DB_NAME].toSorted());
    assert.equal(log[0], 'close:start');
    assert.equal(log[1], 'close:end');
    assert.deepEqual(log.slice(2).toSorted(), [`delete:${OUTBOX_DB_NAME}`, `delete:${PRIMARY_DB_NAME}`].toSorted());
  });

  it('names the two databases the app actually uses (guards the constants)', () => {
    // A wipe that deleted two names nothing writes to would pass every
    // assertion above and leave the device full.
    assert.equal(PRIMARY_DB_NAME, 'translate-primary');
    assert.equal(OUTBOX_DB_NAME, 'translate-outbox');
  });
});
