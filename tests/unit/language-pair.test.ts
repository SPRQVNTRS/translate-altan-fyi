/**
 * The language pair: where it comes from, and what it refuses.
 *
 * WHAT THIS GUARDS. The translator screen used to guess its source language and
 * offer a "flip" link beside the guess, and the pane pinned that flipped
 * direction into every LATER submission. Typing a German word after one tap
 * searched the English side of the dictionary and returned nothing, with
 * nothing on screen saying why. The pair is stated now, by a visible control,
 * and `resolveLanguagePair` is the whole rule for where that statement comes
 * from. These cases are that rule in executable form.
 *
 * THE PRECEDENCE IS THE POINT. The URL beats the cookie, and the cookie beats
 * the default. A shared result link has to render the pair it was captured
 * with, not the pair belonging to whichever device opened it, or the recipient
 * reads one question's answer under another question's heading.
 *
 * THE LIST OF LANGUAGES IS CHECKED AGAINST THE DICTIONARY'S OWN.
 * `language-pair.ts` writes the four served codes out rather than importing
 * `SERVED_LANGUAGES`, because the module that exports that constant pulls the
 * Drizzle schema in with it and this one is loaded by the browser. The type
 * system catches an entry that is not a served language; only a test can catch
 * a served language that is missing, so one does.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { SERVED_LANGUAGES } from '#app/lib/dictionary/detect-language';
import {
  DEFAULT_PAIR,
  DETECT,
  LANGUAGE_NAMES,
  LANGUAGE_PAIR_COOKIE,
  PAIR_LANGUAGES,
  isSourceSelection,
  parseLanguagePairCookie,
  reconcilePairWithDirection,
  resolveLanguagePair,
  serializeLanguagePair,
  type LanguagePair,
} from '#app/lib/dictionary/language-pair';

/** One `Cookie` header carrying a pair, written the way the client writes it. */
function cookieHeaderFor(pair: LanguagePair): string {
  return `${LANGUAGE_PAIR_COOKIE}=${serializeLanguagePair(pair)}`;
}

describe('the offered languages', () => {
  it('holds exactly the languages the dictionary serves', () => {
    assert.deepEqual([...PAIR_LANGUAGES].toSorted(), [...SERVED_LANGUAGES].toSorted());
  });

  it('names every one of them, natively', () => {
    // The names are what the bar puts in front of a reader, so an empty one is
    // a blank row in a language picker. German and Turkish are spelled out
    // because a native name that quietly became an English one would still be
    // a non-empty string.
    for (const code of PAIR_LANGUAGES) {
      assert.notEqual(LANGUAGE_NAMES[code], '');
    }
    assert.equal(LANGUAGE_NAMES.de, 'Deutsch');
    assert.equal(LANGUAGE_NAMES.tr, 'Türkçe');
  });

  it('accepts detection as a source, and never as a target', () => {
    assert.ok(isSourceSelection(DETECT));
    assert.ok(isSourceSelection('tr'));
    assert.equal(isSourceSelection('fr'), false);
    assert.equal(isSourceSelection(''), false);
    assert.equal(isSourceSelection(null), false);
  });
});

describe('the pair cookie', () => {
  it('round-trips every pair the bar can be set to', () => {
    const pairs: LanguagePair[] = [
      { source: DETECT, target: 'de' },
      { source: 'en', target: 'tr' },
      { source: 'es', target: 'en' },
    ];

    for (const pair of pairs) {
      assert.deepEqual(parseLanguagePairCookie(cookieHeaderFor(pair)), pair);
    }
  });

  it('serializes as two codes and a colon', () => {
    assert.equal(serializeLanguagePair({ source: DETECT, target: 'de' }), 'detect:de');
  });

  it('reads a pair out of a header carrying other cookies', () => {
    const header = `translate-language=de; ${LANGUAGE_PAIR_COOKIE}=en:tr; theme=dark`;
    assert.deepEqual(parseLanguagePairCookie(header), { source: 'en', target: 'tr' });
  });

  it('answers null for anything it cannot trust, rather than throwing', () => {
    assert.equal(parseLanguagePairCookie(null), null);
    assert.equal(parseLanguagePairCookie(''), null);
    assert.equal(parseLanguagePairCookie('other=1'), null);
    assert.equal(parseLanguagePairCookie(`${LANGUAGE_PAIR_COOKIE}=de`), null, 'a half pair is not a pair');
    assert.equal(parseLanguagePairCookie(`${LANGUAGE_PAIR_COOKIE}=de:`), null);
    // The languages this dictionary does not serve. A stale cookie from a
    // removed language must fall back to the default, not search a side of the
    // dictionary that is not there.
    assert.equal(parseLanguagePairCookie(`${LANGUAGE_PAIR_COOKIE}=fr:de`), null);
    assert.equal(parseLanguagePairCookie(`${LANGUAGE_PAIR_COOKIE}=de:fr`), null);
    // Detection is a source and only a source.
    assert.equal(parseLanguagePairCookie(`${LANGUAGE_PAIR_COOKIE}=de:detect`), null);
  });
});

describe('resolving the pair for one request', () => {
  it('takes the URL over the cookie, which is what makes a shared link a place', () => {
    const resolved = resolveLanguagePair({
      from: 'tr',
      to: 'en',
      cookieHeader: cookieHeaderFor({ source: 'es', target: 'de' }),
    });

    assert.deepEqual(resolved, { source: 'tr', target: 'en' });
  });

  it('carries detection through the URL as its own literal', () => {
    const resolved = resolveLanguagePair({
      from: DETECT,
      to: 'tr',
      cookieHeader: cookieHeaderFor({ source: 'es', target: 'de' }),
    });

    assert.deepEqual(resolved, { source: DETECT, target: 'tr' });
  });

  it('takes the cookie when the URL says nothing', () => {
    const stored: LanguagePair = { source: 'de', target: 'es' };

    assert.deepEqual(resolveLanguagePair({ from: null, to: null, cookieHeader: cookieHeaderFor(stored) }), stored);
  });

  it('falls back to the default when neither speaks', () => {
    assert.deepEqual(resolveLanguagePair({ from: null, to: null, cookieHeader: null }), DEFAULT_PAIR);
  });

  it('fills in one side from the cookie when the URL states only the other', () => {
    const resolved = resolveLanguagePair({
      from: 'tr',
      to: null,
      cookieHeader: cookieHeaderFor({ source: 'de', target: 'es' }),
    });

    assert.deepEqual(resolved, { source: 'tr', target: 'es' });
  });

  it('ignores a language it does not serve, on either side', () => {
    const resolved = resolveLanguagePair({ from: 'fr', to: 'ja', cookieHeader: null });

    assert.deepEqual(resolved, DEFAULT_PAIR);
  });

  it('repairs a target equal to the source, because that names no edge that exists', () => {
    assert.deepEqual(resolveLanguagePair({ from: 'de', to: 'de', cookieHeader: null }), {
      source: 'de',
      target: 'en',
    });
    assert.deepEqual(resolveLanguagePair({ from: 'en', to: 'en', cookieHeader: null }), {
      source: 'en',
      target: 'de',
    });
    assert.deepEqual(resolveLanguagePair({ from: 'tr', to: 'tr', cookieHeader: null }), {
      source: 'tr',
      target: 'en',
    });
  });

  it('leaves the default target alone when the URL states a different source', () => {
    assert.deepEqual(resolveLanguagePair({ from: 'tr', to: null, cookieHeader: null }), {
      source: 'tr',
      target: DEFAULT_PAIR.target,
    });
  });
});

describe('reconciling the pair with the direction a search ran in', () => {
  it('takes the target the search used, over the pair the reader stated', () => {
    // This is the exact shape of the M187 defect: `pair.target` says German,
    // but `chooseDirection` sent the search to English because the stated
    // source was `detect` and detection resolved to German.
    const pair: LanguagePair = { source: DETECT, target: 'de' };

    const reconciled = reconcilePairWithDirection(pair, { to: 'en' });

    assert.deepEqual(reconciled, { source: DETECT, target: 'en' });
  });

  it('keeps the source exactly as stated, detect included', () => {
    const reconciled = reconcilePairWithDirection({ source: DETECT, target: 'de' }, { to: 'en' });

    assert.equal(reconciled.source, DETECT, 'the bar must still know this was a detection, not a pinned language');
  });

  it('is a no-op when the pair already agreed with the direction', () => {
    const pair: LanguagePair = { source: 'tr', target: 'en' };

    assert.deepEqual(reconcilePairWithDirection(pair, { to: 'en' }), pair);
  });
});
