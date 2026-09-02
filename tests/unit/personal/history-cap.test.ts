/**
 * The search log's two-part cap, driven through the exported pure
 * `pruneHistory(entries, nowMs)` rather than through a store.
 *
 * WHAT THIS PROTECTS
 *   The search log is the most sensitive thing on the device and the one
 *   collection that is never synced (`app/lib/e2ee/BLOB-CONTENTS.md`). The cap
 *   is the only thing that bounds how much of it a device keeps, and it is
 *   applied on every write rather than on a schedule — so a defect here is not
 *   a tidiness problem, it is a device quietly holding years of somebody's
 *   queries.
 *
 * THE DEFECTS THESE CASES CATCH
 *   - Applying ONE half of the cap. Both halves are needed and neither implies
 *     the other, which the two lopsided devices below make concrete.
 *   - An off-by-one at the age boundary, which decides whether an entry
 *     exactly on the 90-day line is kept or dropped. The case states which
 *     side is inclusive, so the answer is a decision rather than an accident.
 *   - A prune that is not idempotent. `recordSearch` re-prunes the whole table
 *     on every single write, so a prune that shrinks a little more each time
 *     would eat a person's history one search at a time, invisibly.
 *   - A result that is not newest-first, which every screen reading it would
 *     have to re-sort.
 *
 * Every count assertion is against the EXPORTED constant, never a literal, so
 * changing the cap cannot leave a green test asserting the old value.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { HISTORY_MAX_AGE_DAYS, HISTORY_MAX_ENTRIES, pruneHistory, type LocalHistoryEntry } from '#app/lib/local-store';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** A fixed "now" so nothing here depends on the wall clock. */
const NOW = 1_760_000_000_000;

/** The oldest instant the age half admits — `pruneHistory` keeps `at >= NOW - days*MS_PER_DAY`. */
const AGE_BOUNDARY = NOW - HISTORY_MAX_AGE_DAYS * MS_PER_DAY;

function entry({ id, at }: { id: string; at: number }): LocalHistoryEntry {
  return { id, query: `query-${id}`, from: 'de', to: 'en', headwordId: null, at };
}

/** `count` entries one minute apart, ending one minute before `NOW` — all comfortably inside the age window. */
function recentEntries(count: number): LocalHistoryEntry[] {
  return Array.from({ length: count }, (_, index) =>
    entry({ id: `e${String(index).padStart(4, '0')}`, at: NOW - (count - index) * 60_000 }),
  );
}

function ids(entries: readonly LocalHistoryEntry[]): string[] {
  return entries.map((item) => item.id);
}

describe('the search-log cap: the count half', () => {
  it('keeps exactly the cap, dropping the oldest and keeping the newest', () => {
    const entries = recentEntries(HISTORY_MAX_ENTRIES + 1);
    const [oldest] = entries;
    const newest = entries.at(-1);
    if (oldest === undefined || newest === undefined) throw new Error('unreachable');

    const kept = pruneHistory(entries, NOW);

    assert.equal(kept.length, HISTORY_MAX_ENTRIES, 'the count cap was not applied to exactly the cap');
    assert.ok(!ids(kept).includes(oldest.id), 'the oldest entry survived the count cap');
    assert.ok(ids(kept).includes(newest.id), 'the newest entry was dropped by the count cap');
  });
});

describe('the search-log cap: the age half', () => {
  it('keeps an entry exactly on the boundary and drops one a millisecond older', () => {
    // THE BOUNDARY IS INCLUSIVE ON THE KEEP SIDE: `pruneHistory` filters on
    // `at >= now - days*MS_PER_DAY`, so an entry whose instant is exactly the
    // 90-day line is KEPT and one instant earlier is dropped. Stated here so a
    // change to that direction fails this case rather than passing quietly.
    const kept = pruneHistory(
      [
        entry({ id: 'one-ms-too-old', at: AGE_BOUNDARY - 1 }),
        entry({ id: 'exactly-on-the-boundary', at: AGE_BOUNDARY }),
        entry({ id: 'well-inside', at: NOW - MS_PER_DAY }),
      ],
      NOW,
    );

    assert.deepEqual(ids(kept), ['well-inside', 'exactly-on-the-boundary'], 'the age boundary is off by one');
    assert.ok(kept.length < HISTORY_MAX_ENTRIES, 'this case must stay under the count cap to isolate the age half');
  });
});

describe('the search-log cap: both halves are needed', () => {
  it('prunes a device that searched once a year for ten years, which the count cap alone would not touch', () => {
    // Ten entries is far under the count cap, and nine of them are years old.
    const decade = Array.from({ length: 10 }, (_, index) =>
      entry({ id: `year-${index}`, at: NOW - index * 365 * MS_PER_DAY }),
    );
    assert.ok(decade.length < HISTORY_MAX_ENTRIES, 'the fixture must be under the count cap for this to isolate the age half');

    const kept = pruneHistory(decade, NOW);

    assert.deepEqual(ids(kept), ['year-0'], 'the age half did not prune a decade-old log that is under the count cap');
  });

  it('prunes a device that searched 900 times this morning, which the age cap alone would not touch', () => {
    const morning = recentEntries(900);
    assert.ok(
      morning.every((item) => item.at >= AGE_BOUNDARY),
      'the fixture must be entirely inside the age window for this to isolate the count half',
    );

    const kept = pruneHistory(morning, NOW);

    assert.equal(kept.length, HISTORY_MAX_ENTRIES, 'the count half did not prune a log that is entirely inside the age window');
  });
});

describe('the search-log cap: shape of the result', () => {
  it('returns newest first, so no screen has to re-sort', () => {
    const shuffled = [
      entry({ id: 'middle', at: NOW - 2 * MS_PER_DAY }),
      entry({ id: 'newest', at: NOW - 1 }),
      entry({ id: 'oldest', at: NOW - 10 * MS_PER_DAY }),
    ];

    assert.deepEqual(ids(pruneHistory(shuffled, NOW)), ['newest', 'middle', 'oldest']);
  });

  it('is idempotent, so re-pruning on every write cannot eat the log a search at a time', () => {
    // `recordSearch` rewrites the whole table through `pruneHistory` on EVERY
    // write, so a prune that shrank a little more each pass would delete a
    // person's history invisibly over a few dozen searches.
    const mixed = [...recentEntries(HISTORY_MAX_ENTRIES + 5), entry({ id: 'ancient', at: AGE_BOUNDARY - MS_PER_DAY })];

    const once = pruneHistory(mixed, NOW);
    const twice = pruneHistory(once, NOW);

    assert.deepEqual(twice, once, 'a second prune at the same instant changed the result');
    assert.equal(once.length, HISTORY_MAX_ENTRIES, 'the first prune did not reach the cap, so idempotence proves nothing here');
  });
});
