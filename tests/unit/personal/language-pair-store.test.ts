/**
 * The language pair survives a reload on this device, and never leaves it.
 *
 * WHAT THIS PROTECTS. The pair is a device preference, held as two TinyBase
 * VALUES. Two promises hang off that sentence, and neither is visible in a
 * typecheck: that the pair a reader picked is still there on the next visit,
 * and that it is not in the blob that replicates to their other devices. A
 * synced pair would let a phone set to Turkish retarget the laptop in the
 * middle of a sentence.
 *
 * THE STORE IS DRIVEN FOR REAL. `createPrimaryStore()` is the same TinyBase
 * store the browser uses, minus the IndexedDB persister, so these cases
 * exercise the read and the write rather than a mock of them, exactly as
 * `tests/unit/nudge-dismissal.test.ts` does for the daily marker.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { DETECT, type LanguagePair } from '#app/lib/dictionary/language-pair';
import {
  createPrimaryStore,
  getLanguagePair,
  listLocalLists,
  listLocalListItems,
  listLocalNotes,
  listLocalReviewState,
  listFavorites,
  putLocalList,
  setLanguagePair,
  toSyncedSnapshot,
} from '#app/lib/local-store';

describe('the device language pair', () => {
  it('has no pair before anybody has picked one', async () => {
    const store = createPrimaryStore();

    assert.equal(await getLanguagePair({ store }), null);
  });

  it('reads back exactly what was written', async () => {
    const store = createPrimaryStore();
    const pair: LanguagePair = { source: 'tr', target: 'en' };

    await setLanguagePair(pair, { store });

    assert.deepEqual(await getLanguagePair({ store }), pair);
  });

  it('keeps detection as a source selection, not as an absent one', async () => {
    const store = createPrimaryStore();

    await setLanguagePair({ source: DETECT, target: 'de' }, { store });

    assert.deepEqual(await getLanguagePair({ store }), { source: DETECT, target: 'de' });
  });

  it('replaces the pair rather than merging the two sides', async () => {
    const store = createPrimaryStore();

    await setLanguagePair({ source: 'de', target: 'en' }, { store });
    await setLanguagePair({ source: 'es', target: 'tr' }, { store });

    assert.deepEqual(await getLanguagePair({ store }), { source: 'es', target: 'tr' });
  });

  it('refuses a tampered or stale pair rather than searching with it', async () => {
    const store = createPrimaryStore();

    // A language this dictionary does not serve, of the kind an older build or
    // a hand-edited store can leave behind.
    store.setValue('sourceLanguage', 'fr');
    store.setValue('targetLanguage', 'de');
    assert.equal(await getLanguagePair({ store }), null);

    // Detection is a source and only a source.
    store.setValue('sourceLanguage', 'de');
    store.setValue('targetLanguage', DETECT);
    assert.equal(await getLanguagePair({ store }), null);
  });

  it('refuses half a pair, because half a preference is not one', async () => {
    const store = createPrimaryStore();

    store.setValue('sourceLanguage', 'de');

    assert.equal(await getLanguagePair({ store }), null);
  });

  it('never enters the synced blob', async () => {
    const store = createPrimaryStore();
    await setLanguagePair({ source: 'tr', target: 'en' }, { store });
    // One real list, so the projection has something to carry and the assertion
    // below is not passing on an empty snapshot.
    await putLocalList({ id: 'l1', name: 'Reise', languagePair: 'tr-en' }, { store });

    const snapshot = toSyncedSnapshot({
      lists: await listLocalLists({ store }),
      listItems: await listLocalListItems({ store }),
      notes: await listLocalNotes({ store }),
      reviewState: await listLocalReviewState({ store }),
      favorites: await listFavorites({ store }),
    });

    assert.equal(snapshot.lists.length, 1, 'the projection carried the list, so it is not empty');
    assert.equal(JSON.stringify(snapshot).includes('sourceLanguage'), false);
    assert.equal(JSON.stringify(snapshot).includes('targetLanguage'), false);
  });
});
