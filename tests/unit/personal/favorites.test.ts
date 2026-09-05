/**
 * The favourites module's own rules, driven against a real in-memory TinyBase
 * store rather than a double.
 *
 * WHAT THIS PROTECTS
 *   A favourite is the one collection in this store whose id is DERIVED rather
 *   than minted (`app/lib/local-store/favorites.ts`). That single decision is
 *   what makes a second tap on a star an overwrite instead of a duplicate row,
 *   and what makes two devices saving the same word converge on one entity. The
 *   derivation is a pure function of `(headwordId, senseId, to)`, so every rule
 *   below is a statement about that key.
 *
 * THE DEFECTS THESE CASES CATCH
 *   - A minted id creeping back in, which would leave two identical-looking
 *     rows on the favourites screen that have to be removed one at a time.
 *   - The target language dropping out of the key, which would silently refuse
 *     the second save when a reader keeps one word in two languages, or
 *     overwrite the first one's answer with the second one's.
 *   - A HARD delete. `listFavorites` filtering a row it deleted looks identical
 *     to `listFavorites` filtering a tombstone, so the cases read the
 *     tombstone off the sync-path read as well as the reader-facing one. A hard
 *     delete would let a peer still holding the live row put the word back.
 *   - A removal that does not outrank the save it removes. A tombstone with an
 *     equal or lower lamport loses the merge, and the word reappears.
 *   - A re-save after a removal that does not outrank the tombstone, which is
 *     the same defect pointing the other way: the star would appear to work and
 *     the word would vanish on the next sync.
 *
 * The store is passed in on every call, so nothing here needs a browser and
 * nothing touches IndexedDB. `deviceId` and `now` are pinned for the same
 * reason: a stamp assertion against a moving clock asserts nothing.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Store } from 'tinybase';

import {
  createPrimaryStore,
  favoriteId,
  getFavorite,
  isFavorite,
  listFavorites,
  listFavoritesIncludingDeleted,
  putFavorite,
  removeFavorite,
  type LocalFavoriteInput,
} from '#app/lib/local-store';

const NOW = 1_760_000_000_000;

/** The write options every case uses: one store, one device, one fixed instant. */
function options(store: Store) {
  return { store, deviceId: 'device-a', now: () => NOW };
}

/** One saved word, with everything but the fields a case is actually varying. */
function favorite(overrides: Partial<LocalFavoriteInput> = {}): LocalFavoriteInput {
  return {
    headwordId: 'hw-1',
    senseId: null,
    lemma: 'Fahrkarte',
    translationSnapshot: 'ticket',
    from: 'de',
    to: 'en',
    ...overrides,
  };
}

describe('the favourite key', () => {
  it('is the same string for the same word, meaning and target language', () => {
    assert.equal(
      favoriteId({ headwordId: 'hw-1', senseId: null, to: 'en' }),
      favoriteId({ headwordId: 'hw-1', senseId: null, to: 'en' }),
    );
  });

  it('separates a word saved with no meaning from the same word saved at one', () => {
    assert.notEqual(
      favoriteId({ headwordId: 'hw-1', senseId: null, to: 'en' }),
      favoriteId({ headwordId: 'hw-1', senseId: 'sense-1', to: 'en' }),
    );
  });

  it('separates the same word in two target languages', () => {
    assert.notEqual(
      favoriteId({ headwordId: 'hw-1', senseId: null, to: 'en' }),
      favoriteId({ headwordId: 'hw-1', senseId: null, to: 'tr' }),
    );
  });
});

describe('saving a word', () => {
  it('is idempotent: the same word saved twice is one row', async () => {
    const store = createPrimaryStore();

    await putFavorite(favorite(), options(store));
    await putFavorite(favorite(), options(store));

    const saved = await listFavorites({ store });
    assert.equal(saved.length, 1, 'the second save added a row instead of overwriting the first');
  });

  it('takes the newer answer when the same word is saved again', async () => {
    const store = createPrimaryStore();

    await putFavorite(favorite({ translationSnapshot: 'ticket' }), options(store));
    await putFavorite(favorite({ translationSnapshot: 'travel ticket' }), options(store));

    const [saved] = await listFavorites({ store });
    assert.ok(saved !== undefined);
    assert.equal(saved.translationSnapshot, 'travel ticket');
    // And the second write outranks the first, so a peer holding the older
    // answer loses the merge rather than winning it back.
    assert.equal(saved.lamport, 2);
  });

  it('keeps one word saved into two target languages as two favourites', async () => {
    const store = createPrimaryStore();

    await putFavorite(favorite({ to: 'en', translationSnapshot: 'ticket' }), options(store));
    await putFavorite(favorite({ to: 'tr', translationSnapshot: 'bilet' }), options(store));

    const saved = await listFavorites({ store });
    assert.equal(saved.length, 2, 'the two target languages collapsed into one row');
    assert.deepEqual(
      saved.map((row) => row.translationSnapshot).toSorted(),
      ['bilet', 'ticket'],
      'one language overwrote the other, so the reader lost an answer they kept',
    );
  });

  it('stamps the row so it can win a merge', async () => {
    const store = createPrimaryStore();

    const saved = await putFavorite(favorite(), options(store));

    assert.equal(saved.deviceId, 'device-a');
    assert.equal(saved.updatedAt, NOW);
    assert.equal(saved.deleted, false);
    assert.ok(saved.lamport > 0, 'an unstamped favourite can never win a merge');
  });

  it('carries the pair, so the row can name it and the search can be re-run', async () => {
    const store = createPrimaryStore();

    await putFavorite(favorite({ from: 'de', to: 'tr' }), options(store));

    const [saved] = await listFavorites({ store });
    assert.ok(saved !== undefined);
    assert.equal(saved.from, 'de');
    assert.equal(saved.to, 'tr');
  });
});

describe('removing a word', () => {
  it('writes a tombstone rather than dropping the row', async () => {
    const store = createPrimaryStore();
    const saved = await putFavorite(favorite(), options(store));

    await removeFavorite(saved.id, options(store));

    const all = await listFavoritesIncludingDeleted({ store });
    assert.equal(all.length, 1, 'the row was hard-deleted, so a peer will put the word back');
    const [tombstone] = all;
    assert.ok(tombstone !== undefined);
    assert.equal(tombstone.deleted, true);
    // The tombstone only wins if it outranks the save it is removing.
    assert.ok(tombstone.lamport > saved.lamport, 'the tombstone did not outrank the save it removes');
  });

  it('is filtered out of the reader-facing list', async () => {
    const store = createPrimaryStore();
    const saved = await putFavorite(favorite(), options(store));

    await removeFavorite(saved.id, options(store));

    assert.deepEqual(await listFavorites({ store }), [], 'a removed favourite is still on the screen');
    assert.equal(await getFavorite(saved.id, { store }), null, 'a tombstone read back as a live row');
  });

  it('leaves a word that was never saved alone', async () => {
    const store = createPrimaryStore();

    await removeFavorite(favoriteId({ headwordId: 'hw-9', senseId: null, to: 'en' }), options(store));

    assert.deepEqual(
      await listFavoritesIncludingDeleted({ store }),
      [],
      'a tombstone was invented for a favourite that never existed',
    );
  });

  it('lets the word be saved again, outranking its own tombstone', async () => {
    const store = createPrimaryStore();
    const saved = await putFavorite(favorite(), options(store));
    await removeFavorite(saved.id, options(store));

    const resaved = await putFavorite(favorite(), options(store));

    assert.equal(resaved.deleted, false);
    assert.equal(resaved.id, saved.id, 'the re-save landed on a different row than the tombstone');
    assert.ok(resaved.lamport > 2, 'the re-save cannot beat its own tombstone, so the word would vanish on sync');
    assert.deepEqual((await listFavorites({ store })).map((row) => row.id), [saved.id]);
  });
});

describe('asking whether a word is saved', () => {
  it('answers by key, not by scanning', async () => {
    const store = createPrimaryStore();
    await putFavorite(favorite({ to: 'en' }), options(store));

    assert.equal(await isFavorite({ headwordId: 'hw-1', senseId: null, to: 'en' }, { store }), true);
    // The same word, a language it was never saved into: the star on that
    // screen must be empty.
    assert.equal(await isFavorite({ headwordId: 'hw-1', senseId: null, to: 'tr' }, { store }), false);
    assert.equal(await isFavorite({ headwordId: 'hw-2', senseId: null, to: 'en' }, { store }), false);
  });

  it('answers false once the word has been removed', async () => {
    const store = createPrimaryStore();
    const saved = await putFavorite(favorite(), options(store));
    await removeFavorite(saved.id, options(store));

    assert.equal(await isFavorite({ headwordId: 'hw-1', senseId: null, to: 'en' }, { store }), false);
  });
});
