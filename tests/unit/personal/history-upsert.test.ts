/**
 * The search log's upsert, driven against a real in-memory TinyBase store
 * rather than a double.
 *
 * WHAT THIS PROTECTS
 *   A search log that appends is a log nobody can read: a word looked up five
 *   times over a week fills the screen with five identical rows, and the one
 *   thing the reader came back for, yesterday's OTHER search, is pushed off
 *   the page by copies. `recordSearch` is therefore an upsert on
 *   `(query, from, to)`, and every case below is a statement about that key.
 *
 * THE DEFECTS THESE CASES CATCH
 *   - An append creeping back in, which is the behaviour this replaced.
 *   - A minted id on an update. The id is what a screen keys a row on, so a
 *     new one on every repeat replaces the row a reader is looking at.
 *   - `headwordId` sneaking into the key. The same typed word can land on a
 *     different top hit as the dictionary grows, and two rows for one search
 *     is exactly the duplication this removes.
 *   - The language pair falling OUT of the key, which would fold one word
 *     searched into two targets into a single row that keeps overwriting
 *     itself.
 *   - A repeat that does not move the row to the top, which is what makes the
 *     log most-recent-first without any screen re-sorting it.
 *   - A later `null` answer wiping a recorded one. The recorder writes twice
 *     for one search, once before the pane has words, so a literal reading of
 *     that `null` would blank an answer the reader can still see.
 *
 * The store is passed in on every call and `now` is pinned, so nothing here
 * needs a browser and no assertion depends on the wall clock.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Store } from 'tinybase';

import { createPrimaryStore, listHistory, recordSearch, type LocalHistoryEntry } from '#app/lib/local-store';

const NOW = 1_760_000_000_000;

/** One search, with everything but the fields a case is actually varying. */
function search(overrides: Partial<Omit<LocalHistoryEntry, 'id' | 'at'>> = {}) {
  return { query: 'umwerfen', from: 'de', to: 'tr', headwordId: 'hw-1', translation: null, ...overrides };
}

function options(store: Store, at: number) {
  return { store, now: () => at };
}

describe('the search log: one row per search', () => {
  it('leaves one row after the same search five times, carrying the latest instant', async () => {
    const store = createPrimaryStore();
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await recordSearch(search(), options(store, NOW + attempt * 60_000));
    }

    const entries = await listHistory({ store });

    assert.equal(entries.length, 1, 'the log appended instead of updating');
    assert.equal(entries[0]?.at, NOW + 4 * 60_000, 'the row did not take the most recent instant');
  });

  it('keeps the row id across an update, so a screen keying on it sees the same row', async () => {
    const store = createPrimaryStore();
    await recordSearch(search(), options(store, NOW));
    const first = (await listHistory({ store }))[0];
    assert.ok(first, 'the first write recorded nothing');

    await recordSearch(search({ translation: 'devirmek' }), options(store, NOW + 1000));
    const second = (await listHistory({ store }))[0];

    assert.equal(second?.id, first.id, 'the update minted a new id');
    assert.equal(second?.translation, 'devirmek', 'the update did not write the answer');
  });

  it('treats a different headword for the same typed search as the same search', async () => {
    const store = createPrimaryStore();
    await recordSearch(search({ headwordId: 'hw-1' }), options(store, NOW));
    await recordSearch(search({ headwordId: 'hw-2' }), options(store, NOW + 1000));

    const entries = await listHistory({ store });

    assert.equal(entries.length, 1, 'the headword is part of the key, so one search became two rows');
    assert.equal(entries[0]?.headwordId, 'hw-2', 'the update did not write the new headword');
  });

  it('treats the same word searched into another language as another search', async () => {
    const store = createPrimaryStore();
    await recordSearch(search({ to: 'tr' }), options(store, NOW));
    await recordSearch(search({ to: 'en' }), options(store, NOW + 1000));

    const entries = await listHistory({ store });

    assert.equal(entries.length, 2, 'the language pair fell out of the key');
    assert.deepEqual(
      entries.map((entry) => entry.to),
      ['en', 'tr'],
      'the two rows are not newest first',
    );
  });

  it('moves a repeated search back to the top', async () => {
    const store = createPrimaryStore();
    await recordSearch(search({ query: 'first' }), options(store, NOW));
    await recordSearch(search({ query: 'second' }), options(store, NOW + 1000));
    await recordSearch(search({ query: 'first' }), options(store, NOW + 2000));

    const entries = await listHistory({ store });

    assert.deepEqual(
      entries.map((entry) => entry.query),
      ['first', 'second'],
      'the repeated search did not move to the top',
    );
  });
});

describe('the search log: the answer on a row', () => {
  it('records a search with no answer yet, then writes the answer onto the same row', async () => {
    const store = createPrimaryStore();
    await recordSearch(search(), options(store, NOW));
    assert.equal((await listHistory({ store }))[0]?.translation, null, 'a search with no answer recorded one');

    await recordSearch(search({ translation: 'devirmek' }), options(store, NOW + 1000));
    const entries = await listHistory({ store });

    assert.equal(entries.length, 1, 'the answer landed on a second row');
    assert.equal(entries[0]?.translation, 'devirmek');
  });

  it('does not let a later null wipe an answer it already holds', async () => {
    // The recorder writes once before the pane has words, so this is the
    // ordinary shape of a repeated search rather than an edge case.
    const store = createPrimaryStore();
    await recordSearch(search({ translation: 'devirmek' }), options(store, NOW));
    await recordSearch(search({ translation: null }), options(store, NOW + 1000));

    const entries = await listHistory({ store });

    assert.equal(entries[0]?.translation, 'devirmek', 'a null answer overwrote a recorded one');
  });
});
