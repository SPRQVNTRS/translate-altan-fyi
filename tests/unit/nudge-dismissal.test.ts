/**
 * The daily nudge appears at most once per local day, and a dismissal survives
 * a reload.
 *
 * WHAT THIS PROTECTS
 *   `app/lib/local-store/nudge.ts` holds the whole rule: a local calendar date
 *   written into one store value, and a comparison against today's. The
 *   component around it does no date arithmetic of its own, so this file is
 *   where the promise "it does not nag" is actually kept.
 *
 *   The store is driven for real. `createPrimaryStore()` is the same TinyBase
 *   store the browser uses, minus the IndexedDB persister, so these cases
 *   exercise the read and the write rather than a mock of them. A reload is
 *   modelled the way a reload behaves: the value is what was persisted, and a
 *   fresh read of it is what the next visit gets.
 *
 * THE DEFECTS THESE CASES CATCH
 *   - A nudge that comes back on the next visit the same day. That is the
 *     nagging the milestone README rules out, and there is no notification
 *     setting for a reader to turn off in response.
 *   - A dismissal that lives only in React state, so a reload deals the same
 *     three words again.
 *   - A marker that never expires, so the nudge is shown exactly once per
 *     device and never again.
 *   - A day boundary computed in UTC (`toISOString().slice(0, 10)`), which
 *     would roll over in the middle of the reader's afternoon or evening
 *     depending on where they are.
 *   - The marker leaking into the synced blob. It is a store VALUE, and the
 *     blob carries collections; the case below asserts the projection of a
 *     store carrying the marker still has no trace of it.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  createPrimaryStore,
  getNudgeShownOn,
  listLocalListItems,
  listLocalNotes,
  listLocalReviewState,
  listFavorites,
  listLocalLists,
  localDateKey,
  markNudgeShown,
  putLocalList,
  putLocalListItem,
  shouldShowNudge,
  toSyncedSnapshot,
} from '#app/lib/local-store';

/** What one visit to the home screen decides, against a store that persists between visits. */
async function visit(store: ReturnType<typeof createPrimaryStore>, at: Date): Promise<boolean> {
  const today = localDateKey(at);
  const isShown = shouldShowNudge({ shownOn: await getNudgeShownOn({ store }), today });
  if (isShown) await markNudgeShown(today, { store });
  return isShown;
}

describe('the local day boundary', () => {
  it('formats the device local date, not the UTC one', () => {
    // 23:30 local on 3 September is still 3 September to the reader, whatever
    // the UTC date says for their offset.
    const lateEvening = new Date(2026, 8, 3, 23, 30, 0);

    assert.equal(localDateKey(lateEvening), '2026-09-03');
  });

  it('pads a single digit month and day', () => {
    assert.equal(localDateKey(new Date(2026, 0, 7, 12, 0, 0)), '2026-01-07');
  });

  it('shows the nudge when it has never been shown on this device', () => {
    assert.equal(shouldShowNudge({ shownOn: null, today: '2026-09-03' }), true);
  });

  it('hides the nudge for the rest of the day it was shown on', () => {
    assert.equal(shouldShowNudge({ shownOn: '2026-09-03', today: '2026-09-03' }), false);
  });

  it('shows it again on any other date, including a clock moved backwards', () => {
    assert.equal(shouldShowNudge({ shownOn: '2026-09-03', today: '2026-09-04' }), true);
    assert.equal(shouldShowNudge({ shownOn: '2026-09-03', today: '2026-09-02' }), true);
  });
});

describe('one nudge per local day', () => {
  it('shows the nudge on the first visit of the day and not on the second', async () => {
    const store = createPrimaryStore();

    assert.equal(await visit(store, new Date(2026, 8, 3, 8, 15, 0)), true, 'the first visit should show it');
    assert.equal(await visit(store, new Date(2026, 8, 3, 12, 40, 0)), false, 'a later visit the same day should not');
    assert.equal(await visit(store, new Date(2026, 8, 3, 23, 59, 0)), false, 'nor should the last visit of the day');
  });

  it('keeps it dismissed across a reload', async () => {
    const store = createPrimaryStore();
    await visit(store, new Date(2026, 8, 3, 8, 15, 0));

    // A reload is a fresh read of the same persisted value, which is exactly
    // what a second `getNudgeShownOn` against this store is.
    assert.equal(await getNudgeShownOn({ store }), '2026-09-03');
    assert.equal(await visit(store, new Date(2026, 8, 3, 8, 16, 0)), false);
  });

  it('shows it again on the next local day', async () => {
    const store = createPrimaryStore();
    await visit(store, new Date(2026, 8, 3, 22, 0, 0));

    assert.equal(await visit(store, new Date(2026, 8, 4, 7, 30, 0)), true);
    assert.equal(await getNudgeShownOn({ store }), '2026-09-04');
  });

  it('ignores a stored value that is not a local date', async () => {
    const store = createPrimaryStore();
    store.setValue('nudgeShownOn', 'yesterday');

    assert.equal(await getNudgeShownOn({ store }), null);
    assert.equal(await visit(store, new Date(2026, 8, 3, 9, 0, 0)), true);
  });
});

describe('the marker never leaves the device', () => {
  it('is absent from the snapshot the encrypted blob carries', async () => {
    const store = createPrimaryStore();
    await markNudgeShown('2026-09-03', { store });
    // Real rows, so the assertions below are made against a payload that
    // genuinely carries something. An empty snapshot would contain no marker
    // however badly the projection were written.
    await putLocalList({ id: 'list-1', name: 'Reise', languagePair: 'de-en' }, { store });
    await putLocalListItem(
      {
        id: 'item-1',
        listId: 'list-1',
        headwordId: 'headword-1',
        senseId: null,
        lemma: 'Gepäck',
        translationSnapshot: 'luggage',
        note: '',
      },
      { store },
    );

    const snapshot = toSyncedSnapshot({
      lists: await listLocalLists({ store }),
      listItems: await listLocalListItems({ store }),
      notes: await listLocalNotes({ store }),
      reviewState: await listLocalReviewState({ store }),
      favorites: await listFavorites({ store }),
    });

    assert.equal(snapshot.listItems.length, 1, 'the fixture should have reached the projection');
    assert.equal(
      JSON.stringify(snapshot).includes('nudgeShownOn'),
      false,
      'the day marker must not ride the encrypted blob',
    );
    assert.equal(JSON.stringify(snapshot).includes('2026-09-03'), false, 'nor may its value, under any other key');
  });
});
