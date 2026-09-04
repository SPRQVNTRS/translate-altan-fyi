/**
 * The teardown order sign-out depends on, proved against the REAL library.
 *
 * ── The defect ────────────────────────────────────────────────────────────
 *
 * A browser walk on 2026-09-04 signed out and found `translate-primary` still
 * in `indexedDB.databases()`, with one console error at the moment of
 * sign-out:
 *
 *   local-store: locked autosave failed
 *   { dbName: "translate-primary", error: "Cannot read properties of undefined (reading 'splice')" }
 *
 * The first case below reproduces that against TinyBase itself, with no
 * IndexedDB involved: calling `persister.save()` AFTER `persister.destroy()`
 * has resolved throws exactly that. The cause is in the library. `destroy()`
 * decrements the persister's schedule reference count to zero and prunes the
 * schedule, which DELETES the action array from the module-level map; a later
 * `save()` pushes onto `undefined` and the scheduler then splices `undefined`.
 *
 * That throw is what left the sign-out half done: it escaped from a save that
 * was still in flight when the close destroyed the persister underneath it.
 *
 * ── What the fix has to be ───────────────────────────────────────────────
 *
 * Not a try/catch. The save has to be finished BEFORE the destroy, so no save
 * can ever be issued afterwards. `startLockedAutoSave` therefore returns a
 * teardown that removes the listeners first and then AWAITS the save loop, and
 * `closePersistedStores` awaits that teardown before it destroys anything.
 *
 * ── Why these cases use the real persister ───────────────────────────────
 *
 * `createCustomPersister` is TinyBase's own scheduler, the same one
 * `createIndexedDbPersister` is built on; only the storage backend differs, and
 * the storage backend is not what breaks. A hand-written double would answer
 * whatever this file made it answer, and the whole question here is what the
 * LIBRARY does.
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createStore, type Content, type Store } from 'tinybase';
import { createCustomPersister, type Persister } from 'tinybase/persisters';

import { startLockedAutoSave } from '#app/lib/local-store/persist';

const DB_NAME = 'translate-primary';

/** A promise a case opens by hand, so a save can be parked mid-flight. */
interface Gate {
  wait: Promise<void>;
  open: () => void;
}

/** Stand-in until the executor hands the real resolver over, one line later. */
function notOpenedYet(): void {}

function openableGate(): Gate {
  let open: () => void = notOpenedYet;
  const wait = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { wait, open };
}

/** One recorded step, so the ORDER of a teardown can be asserted rather than only its effects. */
let log: string[] = [];

beforeEach(() => {
  log = [];
});

/**
 * A real TinyBase persister whose save parks on `gate`.
 *
 * The backend is a variable rather than IndexedDB. Everything this file asks
 * about, the action schedule and its teardown, lives in `createCustomPersister`
 * above that backend.
 */
interface ParkedPersister {
  store: Store;
  persister: Persister;
}

function createParkedPersister(gate: Gate): ParkedPersister {
  const store = createStore();
  let content: Content = [{}, {}];

  const persister = createCustomPersister(
    store,
    async () => content,
    async (getContent: () => Content) => {
      log.push('save:start');
      await gate.wait;
      content = getContent();
      log.push('save:end');
    },
    () => undefined,
    () => undefined,
    () => undefined,
    1,
  );
  return { store, persister };
}

/**
 * Everything `console.error` receives while `run` executes.
 *
 * `persist.ts` reports a failed autosave through `console.error`, and that line
 * is the exact artefact the browser walk saw. A save that throws inside the
 * save loop is CAUGHT there, so it is invisible to an assertion on the
 * promise: the log is the only place it surfaces, which makes it the thing to
 * assert on.
 */
async function errorsLoggedDuring(run: () => Promise<void>): Promise<string[]> {
  const logged: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]): void => {
    logged.push(args.map((arg) => (arg instanceof Error ? arg.message : JSON.stringify(arg))).join(' '));
  };
  try {
    await run();
  } finally {
    console.error = original;
  }
  return logged;
}

/** Lets every queued microtask and timer callback settle. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 20));
}

/**
 * WHAT IS NOT IN THIS FILE, AND WHY. The mirror image of the case below, the
 * OLD order, cannot be run here: destroying first and then letting a write
 * through makes TinyBase fail a second time inside its own scheduler, with no
 * caller left to catch it, and node's test runner counts that as a failure of
 * whatever test is running no matter how it is absorbed. It was reproduced out
 * of band against this same library, and it produces exactly the two messages
 * the browser walk saw:
 *
 *   save() after destroy(): Cannot read properties of undefined (reading 'splice')
 *                           Cannot read properties of undefined (reading 'push')
 *
 * The case below is the half that can be asserted in process: with the drain in
 * place, that failure does not happen.
 */
describe('destroying a persister under a live autosave', () => {
  it('logs nothing when the teardown drains first, which is the fix', async () => {
    const gate = openableGate();
    gate.open();
    const { store, persister } = createParkedPersister(gate);

    const stop = startLockedAutoSave(store, DB_NAME, persister, {
      hasLocks: false,
      loadGate: null,
      flushOnHideDeps: null,
    });

    const logged = await errorsLoggedDuring(async () => {
      // THE ORDER `closePersistedStores` USES: drain and unsubscribe, THEN
      // destroy. A write after that reaches no listener, so no save is issued
      // and there is nothing to fail.
      store.setCell('t', 'r', 'c', 1);
      await stop();
      await persister.destroy();
      store.setCell('t', 'r', 'c', 2);
      await settle();
    });

    assert.deepEqual(logged, [], `the drained teardown still logged: ${logged.join(' | ')}`);

    // NOT VACUOUS. A build where the write never reached the persister at all
    // would log nothing either, and would also never save anybody's words.
    assert.deepEqual(log, ['save:start', 'save:end'], 'the write never reached a save');
  });
});

describe('startLockedAutoSave teardown', () => {
  it('waits for the in-flight save before it resolves', async () => {
    const gate = openableGate();
    const { store, persister } = createParkedPersister(gate);

    const stop = startLockedAutoSave(store, DB_NAME, persister, {
      hasLocks: false,
      loadGate: null,
      flushOnHideDeps: null,
    });

    // A local write starts the save loop, which parks inside the gate.
    store.setCell('t', 'r', 'c', 1);
    await Promise.resolve();
    assert.deepEqual(log, ['save:start'], 'the write did not start a save');

    let hasStopped = false;
    const stopped = stop().then(() => {
      hasStopped = true;
      log.push('stopped');
      return null;
    });

    // The teardown must NOT be finished while the save is still parked.
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(hasStopped, false, 'the teardown resolved while a save was still in flight');

    gate.open();
    await stopped;

    // The order is the property: the save finished first.
    assert.deepEqual(log, ['save:start', 'save:end', 'stopped']);
  });

  it('leaves the persister safe to destroy, which it is not mid-save', async () => {
    const gate = openableGate();
    const { store, persister } = createParkedPersister(gate);

    const stop = startLockedAutoSave(store, DB_NAME, persister, {
      hasLocks: false,
      loadGate: null,
      flushOnHideDeps: null,
    });
    store.setCell('t', 'r', 'c', 1);
    await Promise.resolve();

    gate.open();
    await stop();

    // No save can be issued after this point, because the listener is gone and
    // the loop has drained, so the destroy cannot be raced.
    await persister.destroy();
    assert.ok(log.includes('save:end'), 'the save never completed');
  });

  it('is idempotent, and a second call still waits', async () => {
    const gate = openableGate();
    const { store, persister } = createParkedPersister(gate);

    const stop = startLockedAutoSave(store, DB_NAME, persister, {
      hasLocks: false,
      loadGate: null,
      flushOnHideDeps: null,
    });
    store.setCell('t', 'r', 'c', 1);
    await Promise.resolve();

    // Two sign-out clicks, or a close plus a retry.
    const first = stop();
    const second = stop();
    gate.open();
    await Promise.all([first, second]);

    // One save, not two, and no throw from removing the same listener twice.
    assert.deepEqual(log, ['save:start', 'save:end']);
    await persister.destroy();
  });

  it('covers a write that lands while the save is already parked', async () => {
    const gate = openableGate();
    const { store, persister } = createParkedPersister(gate);

    const stop = startLockedAutoSave(store, DB_NAME, persister, {
      hasLocks: false,
      loadGate: null,
      flushOnHideDeps: null,
    });
    store.setCell('t', 'r', 'c', 1);
    await Promise.resolve();
    // A second write while the first save is parked. The loop must run again
    // for it, and the teardown must wait for THAT one too, or a word typed a
    // moment before sign-out is lost with the database.
    store.setCell('t', 'r', 'c', 2);

    const stopped = stop();
    gate.open();
    await stopped;

    assert.deepEqual(log, ['save:start', 'save:end', 'save:start', 'save:end']);
  });
});
