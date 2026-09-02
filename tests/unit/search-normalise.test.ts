/**
 * The faulty-input matrix: what a reader mistypes, and where it is put right.
 *
 * WHAT THIS FILE CAN PROVE, AND WHAT IT DELIBERATELY CANNOT
 *   Forgiving input is three layers. The FIRST is normalisation, which is pure
 *   string work and is proven here, row by row. The SECOND is trigram
 *   similarity and the THIRD is the did-you-mean suggestion, and both of those
 *   live in Postgres. `tests/integration/did-you-mean.test.ts` proves them
 *   against real rows.
 *
 *   So every row below carries the word the reader MEANT and a `settledBy`
 *   field naming which layer is responsible for it, and the test asserts that
 *   claim rather than restating it. A row marked `fold` must fold onto the
 *   meant word's own search key. A row marked `trigram` must NOT, because if it
 *   did, the normaliser would be silently repairing spelling.
 *
 * WHY "IT MUST NOT REPAIR SPELLING" IS AN ASSERTION AND NOT A COMMENT
 *   A normaliser that quietly turned `hauss` into `haus` would make this whole
 *   file greener and the product worse: an unaccepted correction reads as a
 *   wrong translation, and there would be nothing on screen to say it happened.
 *   The `trigram` rows are what make that regression fail loudly.
 *
 * THE MATRIX IS DATA, AND THE COVERAGE IS DERIVED FROM IT
 *   `feedback_verification_scripts_rot_into_vacuity` is the trap: a hand-copied
 *   list of languages or of fault classes stops covering the real set the
 *   moment either grows. So the language coverage is checked against
 *   `SERVED_LANGUAGES`, which the app itself defines, and the fault coverage
 *   against `FAULT_CLASSES`, which the row type is derived FROM rather than
 *   restated next to.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { SERVED_LANGUAGES, type LanguageCode } from '../../app/lib/dictionary/detect-language';
import { isPhrase, normalizeForLanguage, normalizeQuery } from '../../app/lib/dictionary/normalize';
import { selectPhraseExamples, type ExampleRow } from '../../app/lib/dictionary/search.server';

/**
 * The ways a real query arrives wrong. Every one of these has to be covered by
 * at least one row, and the assertion that says so reads this tuple, so adding
 * a class without a row fails instead of quietly widening the claim.
 */
const FAULT_CLASSES = [
  'trailing-space',
  'trailing-punctuation',
  'surrounding-quotes',
  'wrong-case',
  'stripped-diacritic',
  'doubled-letter',
  'transposition',
  'phrase',
] as const;

type FaultClass = (typeof FAULT_CLASSES)[number];

/** One faulty query, the key it must fold to, and the word the reader meant. */
interface FaultyInput {
  lang: LanguageCode;
  fault: FaultClass;
  /** Exactly what reaches the search box, from a keyboard or from a recogniser. */
  input: string;
  /** The search key `normalizeQuery` must produce. Compared byte for byte. */
  expected: string;
  /** The correctly written form the reader was reaching for. */
  meant: string;
  /** Which layer of forgiving input closes the gap between `expected` and `meant`. */
  settledBy: 'fold' | 'trigram';
  /**
   * Whether this query is a PHRASE, which is the branch the route takes.
   *
   * Stated per row rather than derived from `expected`, because deriving it
   * from the very output under test would make the assertion agree with
   * whatever the code did.
   */
  phrase: boolean;
}

/**
 * The matrix. Four languages, eight fault classes.
 *
 * The German `ß` and the Turkish dotted and dotless i rows are the ones a
 * locale-blind `toLowerCase()` gets wrong, and they are why the fold is per
 * language at all. See `app/lib/dictionary/locale-fold.ts`.
 */
const FAULTY_INPUTS: readonly FaultyInput[] = [
  // German.
  {
    lang: 'de',
    fault: 'trailing-space',
    input: 'Haus ',
    expected: 'haus',
    meant: 'Haus',
    settledBy: 'fold',
    phrase: false,
  },
  {
    lang: 'de',
    fault: 'surrounding-quotes',
    input: '"Haus"',
    expected: 'haus',
    meant: 'Haus',
    settledBy: 'fold',
    phrase: false,
  },
  {
    lang: 'de',
    fault: 'wrong-case',
    input: 'STRASSE',
    expected: 'strasse',
    meant: 'Straße',
    settledBy: 'fold',
    phrase: false,
  },
  {
    lang: 'de',
    fault: 'doubled-letter',
    input: 'Hauss',
    expected: 'hauss',
    meant: 'Haus',
    settledBy: 'trigram',
    phrase: false,
  },
  {
    lang: 'de',
    fault: 'phrase',
    input: 'Guten   Tag!',
    expected: 'guten tag',
    meant: 'Guten Tag',
    settledBy: 'fold',
    phrase: true,
  },

  // English.
  {
    lang: 'en',
    fault: 'trailing-punctuation',
    input: 'Café.',
    expected: 'cafe',
    meant: 'café',
    settledBy: 'fold',
    phrase: false,
  },
  {
    lang: 'en',
    fault: 'transposition',
    input: 'freind',
    expected: 'freind',
    meant: 'friend',
    settledBy: 'trigram',
    phrase: false,
  },
  {
    lang: 'en',
    fault: 'phrase',
    input: '  the   old   man  ',
    expected: 'the old man',
    meant: 'the old man',
    settledBy: 'fold',
    phrase: true,
  },

  // Turkish. `IŞIK` lowercases to `ışık` under Turkish rules and to `işık`
  // under the locale-blind ones, which is a different word and a different key.
  { lang: 'tr', fault: 'wrong-case', input: 'IŞIK', expected: 'isik', meant: 'ışık', settledBy: 'fold', phrase: false },
  {
    lang: 'tr',
    fault: 'stripped-diacritic',
    input: 'igdir',
    expected: 'igdir',
    meant: 'Iğdır',
    settledBy: 'fold',
    phrase: false,
  },
  {
    lang: 'tr',
    fault: 'doubled-letter',
    input: 'issik',
    expected: 'issik',
    meant: 'ışık',
    settledBy: 'trigram',
    phrase: false,
  },

  // Spanish. Folding `ñ` merges `año` and `ano`, which is the recall trade
  // `locale-fold.ts` records; this row only asserts the fold, not the merge.
  {
    lang: 'es',
    fault: 'stripped-diacritic',
    input: 'ano ',
    expected: 'ano',
    meant: 'año',
    settledBy: 'fold',
    phrase: false,
  },
  {
    lang: 'es',
    fault: 'trailing-punctuation',
    input: '¿Cómo estás?',
    expected: 'como estas',
    meant: 'cómo estás',
    settledBy: 'fold',
    phrase: true,
  },
  {
    lang: 'es',
    fault: 'transposition',
    input: 'gracais',
    expected: 'gracais',
    meant: 'gracias',
    settledBy: 'trigram',
    phrase: false,
  },
];

/** A row's label in an assertion message, so a failure names the case. */
function label(row: FaultyInput): string {
  return `${row.lang}/${row.fault} "${row.input}"`;
}

describe('normalizeQuery over the faulty-input matrix', () => {
  for (const row of FAULTY_INPUTS) {
    it(`folds ${label(row)} to "${row.expected}"`, () => {
      const query = normalizeQuery(row.input, row.lang);
      assert.equal(
        query.normalized,
        row.expected,
        `${label(row)} produced "${query.normalized}". That string is compared with a plain "=" ` +
          'against headwords.lemma_normalized, so a wrong key finds nothing at all rather than ' +
          'finding the wrong thing.',
      );
    });
  }

  for (const row of FAULTY_INPUTS) {
    it(`settles ${label(row)} by ${row.settledBy}`, () => {
      // The key the reader's intended word is STORED under, computed by the
      // very function the importer used. This is what "resolves to the right
      // headword" means at the string layer.
      const meantKey = normalizeForLanguage(row.meant, row.lang);
      const query = normalizeQuery(row.input, row.lang);

      if (row.settledBy === 'fold') {
        assert.equal(
          query.normalized,
          meantKey,
          `${label(row)} is claimed to be settled by folding alone, but it folds to ` +
            `"${query.normalized}" while "${row.meant}" is stored under "${meantKey}". The exact ` +
            'branch cannot match these two, so this row now depends on the trigram branch.',
        );
        return;
      }

      assert.notEqual(
        query.normalized,
        meantKey,
        `${label(row)} folded onto "${meantKey}", which means the normaliser REPAIRED a ` +
          'misspelling. It must not: a correction the reader did not accept reads as a wrong ' +
          'translation. Typos belong to the trigram branch and to the did-you-mean suggestion, ' +
          'which is a link the reader clicks.',
      );
    });
  }
});

describe('phrase detection', () => {
  for (const row of FAULTY_INPUTS) {
    it(`agrees on whether ${label(row)} is a phrase`, () => {
      const query = normalizeQuery(row.input, row.lang);
      // The route branches on `normalizeQuery(...).isPhrase` and other callers
      // reach for the standalone `isPhrase`. Two answers here would route a
      // query down the single-word path while another layer counted two words.
      assert.equal(
        query.isPhrase,
        isPhrase(row.input),
        `${label(row)}: the two phrase checks disagree on the raw input`,
      );
      assert.equal(
        query.isPhrase,
        isPhrase(query.normalized),
        `${label(row)}: the phrase check disagrees between the raw and the folded form`,
      );
      assert.equal(
        query.isPhrase,
        row.phrase,
        `${label(row)}: wrong phrase verdict. The route reads this exact value to choose between ` +
          'the single-word branch and the phrase branch, so a wrong verdict sends the query to a ' +
          'path that cannot answer it.',
      );
      assert.equal(query.isPhrase, query.tokens.length > 1, `${label(row)}: isPhrase disagrees with the token count`);
    });
  }

  it('reports an empty query as neither a word nor a phrase', () => {
    const query = normalizeQuery('   ...   ', 'de');
    assert.equal(query.normalized, '', 'punctuation on its own is not a query');
    assert.deepEqual(query.tokens, []);
    assert.equal(query.isPhrase, false);
  });

  it('never offers the raw text as the normalized form', () => {
    // `raw` is carried for the caller's own messages. Nothing may treat it as
    // a search key: it is the unfolded, untrimmed text the reader typed.
    const query = normalizeQuery('  "Straße"  ', 'de');
    assert.equal(query.raw, '  "Straße"  ');
    assert.equal(query.normalized, 'strasse');
  });
});

describe('matrix coverage', () => {
  it('covers every served language', () => {
    const covered = new Set(FAULTY_INPUTS.map((row) => row.lang));
    const missing = SERVED_LANGUAGES.filter((code) => !covered.has(code));
    assert.deepEqual(
      missing,
      [],
      'a served language with no row is a language whose folding rules nothing here checks. ' +
        'SERVED_LANGUAGES is read from the app rather than copied, so a fifth language fails ' +
        'this the day it is added.',
    );
  });

  it('covers every fault class', () => {
    const covered = new Set(FAULTY_INPUTS.map((row) => row.fault));
    const missing = FAULT_CLASSES.filter((fault) => !covered.has(fault));
    assert.deepEqual(missing, [], 'every named fault class needs at least one row');
  });

  it('keeps at least one row on each side of the fold and trigram split', () => {
    // A matrix of nothing but `fold` rows would pass while the trigram branch
    // was deleted, and a matrix of nothing but `trigram` rows would prove the
    // normaliser does nothing at all.
    const folded = FAULTY_INPUTS.filter((row) => row.settledBy === 'fold');
    const trigram = FAULTY_INPUTS.filter((row) => row.settledBy === 'trigram');
    assert.ok(folded.length > 0, 'no row is settled by folding');
    assert.ok(trigram.length > 0, 'no row is left for the trigram branch');
  });
});

/** A candidate sentence row, with only the fields the containment test reads filled in. */
function candidate(id: string, text: string): ExampleRow {
  return {
    headwordId: 'headword',
    id,
    text,
    languageCode: 'de',
    translationText: null,
    translationLanguageCode: null,
    externalId: null,
    sourceSlug: 'tatoeba',
    sourceName: 'Tatoeba',
    sourceLicence: 'CC-BY-2.0-FR',
  };
}

/**
 * The phrase branch decides "does this sentence contain this phrase" in
 * TypeScript, on folded text, because Postgres cannot fold a sentence by the
 * app's own per-language rules. These are the cases that decision has to get
 * right, and none of them needs a database.
 */
describe('phrase containment in example sentences', () => {
  it('matches across punctuation and casing, and through a missing umlaut', () => {
    const rows = [candidate('a', 'Ich habe Hunger, weil es spät ist.')];
    const kept = selectPhraseExamples(rows, 'ich habe hunger', 'de', 5);
    assert.deepEqual(
      kept.map((example) => example.id),
      ['a'],
      'the comma after the phrase hid it. Both sides are folded and stripped of punctuation by ' +
        'normalizeSentence, so a comma standing at the phrase boundary must not matter.',
    );
  });

  it('matches a phrase typed without the German umlaut', () => {
    const rows = [candidate('a', 'Das ist eine schöne Straße.')];
    const kept = selectPhraseExamples(rows, 'schone strasse', 'de', 5);
    assert.deepEqual(
      kept.map((example) => example.id),
      ['a'],
      'a reader without an umlaut key types "schone strasse". The sentence is folded by the same ' +
        'German rules, so both sides reach the same words.',
    );
  });

  it('does not report a match inside a longer word', () => {
    // THE BOUNDARY CASE. Without the space padding, "haus" reports a hit inside
    // "Hausboot" and the phrase results fill with sentences that do not contain
    // the phrase at all.
    const rows = [candidate('a', 'Das Hausboot ist neu.')];
    assert.deepEqual(selectPhraseExamples(rows, 'haus boot', 'de', 5), []);
  });

  it('requires the words to be adjacent and in order', () => {
    const rows = [candidate('a', 'Der Hund sieht die Katze.'), candidate('b', 'Die Katze sieht den Hund.')];
    // Both sentences hold both words. Only the second holds them in this order
    // and next to each other, which is what a phrase is.
    const kept = selectPhraseExamples(rows, 'katze sieht', 'de', 5);
    assert.deepEqual(
      kept.map((example) => example.id),
      ['b'],
      'a phrase is a sequence, not a bag of words. Only the sentence with the words next to each ' +
        'other and in this order contains it.',
    );
  });

  it('caps the result and de-duplicates a sentence returned twice', () => {
    const rows = [candidate('a', 'Guten Tag.'), candidate('a', 'Guten Tag.'), candidate('b', 'Guten Tag, Anna.')];
    const kept = selectPhraseExamples(rows, 'guten tag', 'de', 1);
    assert.deepEqual(
      kept.map((example) => example.id),
      ['a'],
      'the same sentence can arrive twice, once per headword it is attached to',
    );
  });
});
