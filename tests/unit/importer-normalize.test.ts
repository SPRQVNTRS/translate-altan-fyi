/**
 * The normalizers the importers call, and the identity they give a word.
 *
 * WHY THESE DESERVE THEIR OWN FILE
 *   `normalizeForLanguage` decides when two written forms are the same word. It
 *   wrote every value in `headwords.lemma_normalized` on import, and it produces
 *   every value a lookup compares against. A change here does not fail: it
 *   silently moves rows out of reach of the queries that should find them.
 *
 *   `tokenizeForLanguage` is the same function applied to a sentence. The
 *   Tatoeba attachment join sends its output into SQL to be matched against the
 *   stored column with a plain `=`. So the two sides of that equality are only
 *   sound while every token it emits is already in stored form. That is the
 *   last case in this file and it is the load-bearing one.
 *
 *   `normalizeLemma` is the language-blind survivor, and language detection is
 *   its only caller. The per-language rules and their matrix live in
 *   `tests/unit/locale-fold.test.ts`; this file covers what the IMPORTERS see.
 *
 * NO DATABASE. `cli/lib/importers/normalize.ts` imports nothing at all, so this
 * file opens no pool and needs no mock.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeLemma,
  normalizeForLanguage,
  tokenizeForLanguage,
} from '../../cli/lib/importers/normalize';

describe('normalizeLemma', () => {
  it('folds case and strips accents, so two spellings of one word meet', () => {
    // French borrowed into German and English dictionaries alike.
    assert.equal(normalizeLemma('Café'), 'cafe');
    assert.equal(normalizeLemma('CAFE'), 'cafe');
    assert.equal(normalizeLemma('Café'), normalizeLemma('CAFE'));

    // A German umlaut and a Spanish acute are both combining marks under NFD.
    assert.equal(normalizeLemma('Grün'), 'grun');
    assert.equal(normalizeLemma('GRUN'), 'grun');
    assert.equal(normalizeLemma('Canción'), 'cancion');
    assert.equal(normalizeLemma('CANCION'), 'cancion');
  });

  it('keeps ß, which is a letter and not an accented s', () => {
    // ß carries no combining mark, so NFD leaves it whole and nothing strips
    // it. The value is asserted rather than merely "not empty": a future
    // normalizer that folded ß to ss would still be truthy here and would
    // quietly re-key every German headword that contains one.
    assert.equal(normalizeLemma('Straße'), 'straße');
    assert.equal(normalizeLemma('GROẞ'), 'groß');

    // The consequence, stated so it cannot be mistaken for an oversight: the
    // ss spelling is a DIFFERENT stored form. Swiss German text will not meet
    // German text on these words.
    assert.equal(normalizeLemma('STRASSE'), 'strasse');
    assert.notEqual(normalizeLemma('Straße'), normalizeLemma('Strasse'));
  });

  it('collapses runs of whitespace and trims the ends', () => {
    assert.equal(normalizeLemma('  Guten   Morgen \n'), 'guten morgen');
    assert.equal(normalizeLemma('\tarco\t\tiris '), 'arco iris');
    assert.equal(normalizeLemma('   '), '');
  });
});

describe('tokenizeForLanguage', () => {
  it('splits on punctuation, keeps hyphens and apostrophes inside a word', () => {
    // "Don't" and "don't" are the same token, so only the first survives, in
    // the position it first appeared. "E-mail" stays one token because a
    // hyphen is part of a word here, not a separator.
    assert.deepEqual(tokenizeForLanguage("Don't stop, don't! E-mail me.", 'en'), [
      "don't",
      'stop',
      'e-mail',
      'me',
    ]);
  });

  it('deduplicates while keeping first-appearance order', () => {
    // The order is the whole point: this array is interpolated into a SQL
    // statement, so two runs over one sentence must build one statement.
    assert.deepEqual(tokenizeForLanguage('Ein E-Mail-Konto, ein Konto.', 'de'), [
      'ein',
      'e-mail-konto',
      'konto',
    ]);
  });

  it('drops empty pieces, including from a string with no words at all', () => {
    assert.deepEqual(tokenizeForLanguage('!!! ... ???', 'en'), []);
    assert.deepEqual(tokenizeForLanguage('', 'en'), []);
    assert.deepEqual(tokenizeForLanguage('¡Hola!', 'es'), ['hola']);
  });

  it('emits only tokens that are already in stored form', () => {
    // THE PROPERTY THAT MAKES THE TATOEBA JOIN SOUND.
    //
    // `attachHeadwords` matches these tokens against `headwords.lemma_normalized`
    // with a plain `=`, and that column was written by `normalizeForLanguage` in
    // the headword's own language. So a token is findable only when it is a
    // fixed point of the SAME language's normalizer:
    // `normalizeForLanguage(token, lang) === token`. If tokenizing ever emitted
    // a form that normalizing would change, the join would return fewer rows, no
    // error would be raised, and nothing would tell us the matches were lost.
    const sentences: ReadonlyArray<readonly [language: string, sentence: string]> = [
      ['de', 'Das Leben ist wunderschön!'],
      ['de', 'Sein Gesicht zeigte Spuren von Ausschweifung.'],
      ['de', 'Die Straße war groß und weiß.'],
      ['es', '¡El pueblo unido jamás será vencido!'],
      ['tr', 'Çoğu kişi bilgisayarların asla düşünemeyeceklerini düşünüyor.'],
      ['tr', 'IĞDIR ve Işık, ışık ve İstanbul.'],
      ['en', 'Children who spend more time outdoors have a lower risk of myopia.'],
      ['en', "  Don't   stop,  don't! "],
    ];

    for (const [language, sentence] of sentences) {
      const tokens = tokenizeForLanguage(sentence, language);
      assert.ok(tokens.length > 0, `no tokens from: ${sentence}`);
      for (const token of tokens) {
        assert.equal(
          normalizeForLanguage(token, language),
          token,
          `"${token}" from "${sentence}" is not in stored form, so the SQL join would miss it`,
        );
      }
    }
  });
});

describe('the language-blind normalizer, and why the importers do not use it', () => {
  it('gets Turkish wrong, which is exactly why it is not the stored form', () => {
    // In Turkish the lowercase of I is ı and the lowercase of İ is i.
    // `normalizeLemma` has no language, so it uses JavaScript's locale-free
    // `toLowerCase`, which maps both capitals towards i. The uppercase and
    // lowercase spellings of one Turkish word therefore disagree.
    assert.equal(normalizeLemma('ışık'), 'ısık');
    assert.equal(normalizeLemma('IŞIK'), 'isik');
    assert.notEqual(normalizeLemma('IŞIK'), normalizeLemma('ışık'));

    // The language-aware normalizer, the one that writes the column, agrees.
    assert.equal(normalizeForLanguage('ışık', 'tr'), 'isik');
    assert.equal(normalizeForLanguage('IŞIK', 'tr'), 'isik');
    assert.equal(normalizeForLanguage('Işık', 'tr'), 'isik');
  });

  it('leaves the German sharp s where the stored form folds it', () => {
    // The two disagree here too, and the disagreement is the reason a lookup
    // must never be built on `normalizeLemma`.
    assert.equal(normalizeLemma('Straße'), 'straße');
    assert.equal(normalizeForLanguage('Straße', 'de'), 'strasse');
    assert.equal(normalizeForLanguage('STRASSE', 'de'), 'strasse');
  });

  it('refuses a language it has no rules for, rather than guessing', () => {
    // A silent fall back to English would store a French or Polish row under a
    // key folded by the wrong rules. Nothing would raise, and the row would
    // simply never be found again.
    assert.throws(
      () => normalizeForLanguage('żółw', 'pl'),
      /No case and fold rules for language "pl"/,
    );
  });
});
