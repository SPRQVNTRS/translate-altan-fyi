/**
 * The per-language casing and folding matrix.
 *
 * WHY THE MATRIX IS DATA AND NOT A LIST OF ASSERTIONS
 *   A hand-written assertion per letter is a list that narrows silently: a
 *   language gains a rule, nobody adds the row, and the file still passes while
 *   covering less than it did. The rows below are one array, every case iterates
 *   it, and a new row is automatically covered by every case in the file.
 *
 * WHAT ONE ROW SAYS
 *   A row names a language, a search key, and every written form that must
 *   reach that key: the correctly cased and accented spelling, the spelling a
 *   reader without that keyboard types, and where the case pairing is the point,
 *   the wrongly cased spelling too. `Iğdır`, `IĞDIR` and `igdir` are one row
 *   because they are one word, and a reader typing any of the three must find
 *   the entry.
 *
 * WHAT THE FILE IS FALSIFIABLE BY
 *   Replace the Turkish `caseLocale` in `app/lib/dictionary/locale-fold.ts` with
 *   a plain `toLowerCase`, or drop the `ı` to `i` fold, and the rows named
 *   "tr: ..." go red. That run is recorded in `docs/falsification.md` under
 *   "M173/04". A matrix that cannot go red is a matrix nobody should trust.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { foldForSearch, lowerCaseFor, isFoldLanguage } from '../../app/lib/dictionary/locale-fold';
// The two ends of the drift the whole design exists to prevent. `queryPath` is
// what `search.server.ts` imports; `importPath` is what the importers import,
// through `cli/lib/importers/normalize.ts`. They must be one function.
import { normalizeForLanguage as queryPath } from '../../app/lib/dictionary/normalize';
import { normalizeForLanguage as importPath } from '../../cli/lib/importers/normalize';

/** The v1 served languages. Every one of them needs at least one row below. */
const LANGUAGES = ['en', 'de', 'tr', 'es'] as const;

type FoldRow = {
  /** Names the row in a failure message, and in the falsification record. */
  readonly name: string;
  readonly language: string;
  /** Written forms that must all reach `key`. */
  readonly inputs: readonly string[];
  /** The search key `headwords.lemma_normalized` holds for this word. */
  readonly key: string;
};

/**
 * ONE ROW PER LANGUAGE AND LETTER CLASS: the correct case pair, the
 * diacritic-stripped input a foreign keyboard produces, and the accented input.
 */
const FOLD_ROWS: readonly FoldRow[] = [
  // --- Turkish: the dotless i, which is the reason this module exists --------
  {
    name: 'tr: Iğdır, the city, typed on an English keyboard',
    language: 'tr',
    inputs: ['Iğdır', 'IĞDIR', 'ığdır', 'igdir', 'IGDIR', 'Igdir'],
    key: 'igdir',
  },
  {
    name: 'tr: Işık, where the wrong i is what a reader actually types',
    language: 'tr',
    inputs: ['Işık', 'ışık', 'IŞIK', 'Isik', 'isik', 'ISIK', 'İşik'],
    key: 'isik',
  },
  {
    name: 'tr: İstanbul, the dotted capital I',
    language: 'tr',
    inputs: ['İstanbul', 'istanbul', 'İSTANBUL', 'Istanbul', 'ıstanbul'],
    key: 'istanbul',
  },
  {
    name: 'tr: çağdaş, the cedillas and the breve',
    language: 'tr',
    inputs: ['çağdaş', 'ÇAĞDAŞ', 'Çağdaş', 'cagdas', 'CAGDAS'],
    key: 'cagdas',
  },
  {
    name: 'tr: gönül, the umlauted vowels',
    language: 'tr',
    inputs: ['gönül', 'GÖNÜL', 'Gönül', 'gonul', 'GONUL'],
    key: 'gonul',
  },

  // --- German: the sharp s, which is length-changing ------------------------
  {
    name: 'de: Straße, where ß folds to two letters',
    language: 'de',
    inputs: ['Straße', 'straße', 'STRASSE', 'strasse', 'Strasse', 'STRAẞE'],
    key: 'strasse',
  },
  {
    name: 'de: grün, the umlaut folded to its base letter',
    language: 'de',
    inputs: ['grün', 'GRÜN', 'Grün', 'grun', 'GRUN'],
    key: 'grun',
  },
  {
    name: 'de: Bär, the a umlaut',
    language: 'de',
    inputs: ['Bär', 'bär', 'BÄR', 'bar', 'Bar'],
    key: 'bar',
  },

  // --- Spanish: the tilde, where recall beats precision ---------------------
  {
    name: 'es: niño, where ñ folds to n',
    language: 'es',
    inputs: ['niño', 'NIÑO', 'Niño', 'nino', 'NINO'],
    key: 'nino',
  },
  {
    name: 'es: canción, the acute accent',
    language: 'es',
    inputs: ['canción', 'CANCIÓN', 'Canción', 'cancion', 'CANCION'],
    key: 'cancion',
  },

  // --- English: the plain fold, and the loanwords that still need it --------
  {
    name: 'en: café, a loanword that keeps its accent in writing',
    language: 'en',
    inputs: ['café', 'CAFÉ', 'Café', 'cafe', 'CAFE'],
    key: 'cafe',
  },
  {
    name: 'en: naive, the diaeresis',
    language: 'en',
    inputs: ['naïve', 'NAÏVE', 'Naïve', 'naive', 'NAIVE'],
    key: 'naive',
  },
];

/**
 * The casing rows. Casing is NOT the search key: `lowerCaseFor` keeps letters
 * apart that `foldForSearch` deliberately merges, and this is where the
 * difference is pinned.
 */
type CaseRow = {
  readonly name: string;
  readonly language: string;
  readonly input: string;
  readonly lowered: string;
};

const CASE_ROWS: readonly CaseRow[] = [
  { name: 'tr: I lowercases to the dotless i', language: 'tr', input: 'I', lowered: 'ı' },
  { name: 'tr: İ lowercases to the dotted i', language: 'tr', input: 'İ', lowered: 'i' },
  { name: 'tr: IŞIK keeps its dotless i', language: 'tr', input: 'IŞIK', lowered: 'ışık' },
  { name: 'tr: İSTANBUL keeps its dotted i', language: 'tr', input: 'İSTANBUL', lowered: 'istanbul' },
  { name: 'de: I lowercases to the dotted i', language: 'de', input: 'I', lowered: 'i' },
  { name: 'de: GROSS stays two letters', language: 'de', input: 'GROSS', lowered: 'gross' },
  { name: 'es: NIÑO keeps its tilde', language: 'es', input: 'NIÑO', lowered: 'niño' },
  { name: 'en: CAFÉ keeps its accent', language: 'en', input: 'CAFÉ', lowered: 'café' },
];

describe('foldForSearch, per language', () => {
  for (const row of FOLD_ROWS) {
    it(`${row.name}: every spelling reaches "${row.key}"`, () => {
      for (const input of row.inputs) {
        assert.equal(
          foldForSearch(input, row.language),
          row.key,
          `"${input}" in ${row.language} folded to "${foldForSearch(input, row.language)}", ` +
            `not "${row.key}". A reader who typed it would find nothing.`,
        );
      }
    });
  }

  it('covers every served language', () => {
    // The guard against the matrix narrowing: a fifth language added to the
    // module with no row here would otherwise be silently untested.
    const covered = new Set(FOLD_ROWS.map((row) => row.language));
    for (const language of LANGUAGES) {
      assert.ok(covered.has(language), `no fold row covers ${language}`);
      assert.ok(isFoldLanguage(language), `${language} has no rules in locale-fold.ts`);
    }
  });

  it('is idempotent, so a folded form is its own search key', () => {
    // `headwords.lemma_normalized` is compared with a plain `=`. Re-folding a
    // stored form must therefore be a no-op, or a re-import would move rows.
    for (const row of FOLD_ROWS) {
      assert.equal(
        foldForSearch(row.key, row.language),
        row.key,
        `${row.name}: the key "${row.key}" is not a fixed point of its own fold`,
      );
    }
  });
});

describe('lowerCaseFor, which is the DISPLAY answer and not the search key', () => {
  for (const row of CASE_ROWS) {
    it(`${row.name}`, () => {
      assert.equal(lowerCaseFor(row.input, row.language), row.lowered);
    });
  }

  it('never maps the Turkish I to a dotted i', () => {
    // The single assertion the whole spec turns on. `'I'.toLowerCase()` is
    // `'i'`, which is a different letter and a different word in Turkish.
    assert.notEqual(lowerCaseFor('I', 'tr'), 'i');
    assert.equal(lowerCaseFor('I', 'tr'), 'ı');
  });

  it('keeps the Turkish i letters apart where folding merges them', () => {
    // This is the precision half of the trade. Casing distinguishes; the search
    // key does not, and that difference is deliberate rather than an oversight.
    assert.notEqual(lowerCaseFor('IŞIK', 'tr'), lowerCaseFor('İŞİK', 'tr'));
    assert.equal(foldForSearch('IŞIK', 'tr'), foldForSearch('İŞİK', 'tr'));
  });
});

describe('the import path and the query path are one function', () => {
  // THE INVARIANT THE DESIGN EXISTS FOR. `headwords.lemma_normalized` is written
  // by the importers and compared by the search with a plain `=`. Two functions
  // that agree today are the failure this asserts against: nothing would raise
  // when they stopped agreeing, and rows would simply stop being found.
  for (const row of FOLD_ROWS) {
    it(`${row.name}: both paths produce the same stored form`, () => {
      for (const input of row.inputs) {
        const stored = importPath(input, row.language);
        const queried = queryPath(input, row.language);
        assert.equal(
          stored,
          queried,
          `${row.name}: the importer stores "${stored}" for "${input}" while the search ` +
            `looks up "${queried}". Every row of this word is unreachable.`,
        );
        assert.equal(stored, row.key);
      }
    });
  }

  it('is literally the same function reference', () => {
    // Stronger than agreeing on the rows above: `cli/lib/importers/normalize.ts`
    // is a re-export, and this fails the moment it becomes a copy.
    assert.equal(importPath, queryPath);
  });
});

describe('an unserved language', () => {
  it('throws rather than folding by English rules', () => {
    assert.ok(!isFoldLanguage('fr'));
    assert.throws(() => foldForSearch('œuf', 'fr'), /No case and fold rules for language "fr"/);
    assert.throws(() => lowerCaseFor('ŒUF', 'fr'), /No case and fold rules for language "fr"/);
  });
});
