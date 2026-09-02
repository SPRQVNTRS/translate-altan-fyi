/**
 * The direction guess, branch by branch.
 *
 * WHY THIS FILE EXISTS
 *   The direction is a GUESS, and the guess selects which side of the
 *   dictionary the query runs against. A wrong guess returns correct rows for
 *   the wrong language, so it reads as an empty or nonsensical result page
 *   rather than as an error. Nothing throws, nothing logs, and the page still
 *   renders a plausible chip above the results.
 *
 *   Every branch in `chooseDirection` returns a well-formed `Direction`, which
 *   is exactly what makes the precedence order easy to break silently in a
 *   later refactor. So each branch gets its own case here, and each case names
 *   the rule it is holding down.
 *
 * NO DATABASE IS TOUCHED BY THE PURE HALF
 *   `chooseDirection` takes the hit counts as data. The tests below call it
 *   with no database handle at all, which is the assertion: if the function
 *   ever grew a query, these calls could not compile or could not run.
 *
 * THE COUNTING PATH OF `detectLanguage` IS AN INTEGRATION TEST
 *   `detectLanguage` builds its count query through the Drizzle builder and
 *   awaits it. A hand-written fake would have to imitate the whole builder
 *   chain and then be asserted into the `DictionaryDb` type, which would test
 *   the fake rather than the code. So the counting path is covered by
 *   `tests/integration/dictionary-search.test.ts`, against a real database, and
 *   what is covered here is the pair of short circuits that must NOT reach the
 *   database at all.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from '../../drizzle/schema';
import {
  SERVED_LANGUAGES,
  chooseDirection,
  detectLanguage,
  isServedLanguage,
  type ChooseDirectionInput,
  type Direction,
} from '../../app/lib/dictionary/detect-language';

/** Deliberately unreachable: a short circuit that queries anything fails loudly. */
const UNREACHABLE_DSN = 'postgres://user:pass@127.0.0.1:1/none';

const db = drizzle(new pg.Pool({ connectionString: UNREACHABLE_DSN }), { schema });

/**
 * Call the pure decision with the fields a case cares about.
 *
 * No database handle is threaded anywhere, on purpose. See the header.
 *
 * @param input The subset of the decision inputs this case is about.
 * @returns The direction the module chose.
 */
function decide(input: Partial<ChooseDirectionInput>): Direction {
  return chooseDirection({ q: '', exactHitsByLanguage: {}, ...input });
}

/**
 * Values that arrive in the URL and name no served language.
 *
 * `EN` is in the list because the check is case sensitive, and an uppercase
 * code is the shape a hand-edited URL or a careless link produces.
 */
const UNSERVED = ['fr', 'EN', 'de-DE', 'zz', '', 'not-a-language'] as const;

// =============================================================================
// Rule 1: a valid `from` in the URL wins outright
// =============================================================================

describe('a stated from wins over every piece of evidence', () => {
  it('beats the hit counts, and reports detected: false', () => {
    // The counts scream Spanish. The reader said German, so nothing else is
    // consulted: `detected` is the flag the UI uses to decide whether it may
    // offer the reader a correction, so it must be false here.
    assert.deepEqual(
      decide({ q: 'casa', from: 'de', exactHitsByLanguage: { es: 99 } }),
      { from: 'de', to: 'en', detected: false },
    );
  });

  it('beats the character heuristic', () => {
    // `ñ` says Spanish. The URL says Turkish, and the URL is the reader's own
    // statement about their own query.
    assert.deepEqual(decide({ q: 'año', from: 'tr' }), { from: 'tr', to: 'en', detected: false });
  });

  it('accepts every served language as a stated from', () => {
    for (const language of SERVED_LANGUAGES) {
      const direction = decide({ q: 'x', from: language, exactHitsByLanguage: { es: 5 } });
      assert.equal(direction.from, language, `a stated from of ${language} was overruled`);
      assert.equal(direction.detected, false);
    }
  });
});

describe('a from the dictionary does not serve falls through', () => {
  for (const from of UNSERVED) {
    it(`ignores from=${JSON.stringify(from)} and uses the counts instead`, () => {
      // The dangerous failure is the opposite: an unserved code accepted as
      // `from` would search a language column that holds no rows, and the page
      // would be empty rather than wrong. `detected` must also flip to true,
      // because nothing the reader said survived.
      assert.deepEqual(
        decide({ q: 'casa', from, exactHitsByLanguage: { es: 3 } }),
        { from: 'es', to: 'en', detected: true },
      );
    });
  }

  it('treats a null or absent from as unstated', () => {
    assert.deepEqual(
      decide({ q: 'casa', from: null, exactHitsByLanguage: { es: 3 } }),
      { from: 'es', to: 'en', detected: true },
    );
    assert.deepEqual(
      decide({ q: 'casa', exactHitsByLanguage: { es: 3 } }),
      { from: 'es', to: 'en', detected: true },
    );
  });
});

// =============================================================================
// Rule 2: the most exact hits wins
// =============================================================================

describe('the exact hit counts decide when the URL does not', () => {
  it('picks the language with the most hits, and reports detected: true', () => {
    assert.deepEqual(
      decide({ q: 'bank', exactHitsByLanguage: { en: 2, de: 7 } }),
      { from: 'de', to: 'en', detected: true },
    );
  });

  it('outranks the character heuristic, which ä alone cannot settle', () => {
    // `ä` is written in German AND in Turkish, so the heuristic guesses German
    // on a character that is not German-only. A real hit in the Turkish
    // headword table is evidence the heuristic does not have, and it must win.
    assert.deepEqual(
      decide({ q: 'kâğıdä', exactHitsByLanguage: { tr: 4 } }),
      { from: 'tr', to: 'en', detected: true },
    );
    // Same query, no counts: now the heuristic is all there is, and it says
    // German. The pair of cases together is what proves the precedence, since
    // either one alone is satisfied by the wrong order too.
    assert.equal(decide({ q: 'kâğıdä' }).from, 'de');
  });

  it('breaks a tie by SERVED_LANGUAGES order', () => {
    // Documented in the module: the comparison is `>` rather than `>=`, so the
    // FIRST language in the declaration order wins a tie. The requirement is
    // only that the answer be identical on every request, because a tie broken
    // by row order would move the whole page between two identical requests.
    assert.equal(SERVED_LANGUAGES[0], 'en', 'the tie-break order changed, so these cases must too');
    assert.equal(decide({ q: 'bank', exactHitsByLanguage: { en: 5, de: 5 } }).from, 'en');
    assert.equal(decide({ q: 'bank', exactHitsByLanguage: { de: 5, tr: 5 } }).from, 'de');
    assert.equal(decide({ q: 'bank', exactHitsByLanguage: { tr: 5, es: 5 } }).from, 'tr');
    assert.equal(
      decide({ q: 'bank', exactHitsByLanguage: { en: 1, de: 1, tr: 1, es: 1 } }).from,
      'en',
    );
  });

  it('ignores languages counted at zero', () => {
    // A grouped count never returns a zero row, but the map is `Partial` and a
    // caller may hand one over. Zero hits is no evidence, so the decision must
    // fall through to the heuristic rather than settle on the zero-hit language.
    assert.equal(decide({ q: 'año', exactHitsByLanguage: { de: 0, tr: 0 } }).from, 'es');
  });
});

// =============================================================================
// Rule 3: the character heuristic
// =============================================================================

describe('the character heuristic speaks when the dictionary has no opinion', () => {
  for (const [q, expected] of [
    ['straße', 'de'],
    ['bär', 'de'],
    ['schön', 'de'],
    ['über', 'de'],
    ['dağ', 'tr'],
    ['DAĞ', 'tr'],
    ['ışık', 'tr'],
    ['şeker', 'tr'],
    ['İstanbul', 'tr'],
    // No umlaut in any of the four: `ö` and `ü` are shared with German and are
    // claimed by the German pattern, which runs first. That is the module's
    // documented reading, not an oversight, and the case below pins it.
    ['año', 'es'],
    ['¿qué?', 'es'],
    ['¡hola!', 'es'],
  ] as const) {
    it(`reads ${JSON.stringify(q)} as ${expected}`, () => {
      // The UI language is English throughout, so its partner is German. The
      // Turkish and Spanish cases therefore only pass if the heuristic ran.
      const direction = decide({ q, uiLanguage: 'en' });
      assert.equal(direction.from, expected);
      assert.equal(direction.detected, true);
    });
  }

  it('reads a query carrying both German and Turkish letters as German', () => {
    // German is tested first inside the heuristic. `ö` is shared, so a word
    // holding `ö` and `ş` matches both patterns and the order is the answer.
    assert.equal(decide({ q: 'şöy' }).from, 'de');
  });

  it('finds no signal in plain ASCII', () => {
    // Falls through to rule 4, whose partner of an English UI is German.
    assert.deepEqual(decide({ q: 'house', uiLanguage: 'en' }), {
      from: 'de',
      to: 'en',
      detected: true,
    });
  });
});

// =============================================================================
// Rule 4: the pair partner of the UI language
// =============================================================================

describe('the last resort is the pair partner of the UI language', () => {
  it('sends a German reader from English', () => {
    // Someone reading the interface in German is most likely looking up an
    // English word, not a German one.
    assert.deepEqual(decide({ q: 'house', uiLanguage: 'de' }), {
      from: 'en',
      to: 'de',
      detected: true,
    });
  });

  it('sends an English reader from German', () => {
    assert.deepEqual(decide({ q: 'haus', uiLanguage: 'en' }), {
      from: 'de',
      to: 'en',
      detected: true,
    });
  });

  it('sends a Turkish or Spanish reader from English', () => {
    // Turkish and Spanish are served against English, so their partner is
    // English on both sides of the pair.
    assert.equal(decide({ q: 'house', uiLanguage: 'tr' }).from, 'en');
    assert.equal(decide({ q: 'house', uiLanguage: 'es' }).from, 'en');
  });

  it('treats an unserved or absent UI language as English', () => {
    for (const uiLanguage of [...UNSERVED, null]) {
      assert.equal(
        decide({ q: 'house', uiLanguage }).from,
        'de',
        `uiLanguage ${JSON.stringify(uiLanguage)} did not fall back to the English partner`,
      );
    }
    assert.equal(decide({ q: 'house' }).from, 'de');
  });

  it('applies to an empty query, which has no characters to read', () => {
    assert.deepEqual(decide({ q: '', uiLanguage: 'de' }), {
      from: 'en',
      to: 'de',
      detected: true,
    });
    assert.deepEqual(decide({ q: '   ', uiLanguage: 'en' }), {
      from: 'de',
      to: 'en',
      detected: true,
    });
  });
});

// =============================================================================
// The target
// =============================================================================

describe('the target is the URL value, or the pair partner of from', () => {
  it('honours a stated to that names a different language', () => {
    assert.deepEqual(decide({ q: 'haus', from: 'de', to: 'tr' }), {
      from: 'de',
      to: 'tr',
      detected: false,
    });
  });

  for (const to of UNSERVED) {
    it(`ignores to=${JSON.stringify(to)} and uses the partner`, () => {
      assert.equal(decide({ q: 'haus', from: 'de', to }).to, 'en');
    });
  }

  it('pairs Turkish and Spanish with English, not with each other', () => {
    assert.equal(decide({ q: 'x', from: 'tr' }).to, 'en');
    assert.equal(decide({ q: 'x', from: 'es' }).to, 'en');
  });

  it('corrects a to that equals a stated from', () => {
    // `de -> de` names no edge that exists, so it would return an empty page
    // for a query that has answers. `from` is kept because it is the side the
    // query searches: repairing `to` changes which answers are shown, while
    // repairing `from` would change which word was looked up.
    assert.deepEqual(decide({ q: 'haus', from: 'de', to: 'de' }), {
      from: 'de',
      to: 'en',
      detected: false,
    });
  });

  it('corrects a to that equals a detected from', () => {
    // The collision can also appear without a stated `from`, once the counts
    // have chosen one. The repair has to happen after the choice, not while
    // reading the URL.
    assert.deepEqual(decide({ q: 'casa', to: 'es', exactHitsByLanguage: { es: 3 } }), {
      from: 'es',
      to: 'en',
      detected: true,
    });
  });

  it('never returns a direction whose two sides are the same language', () => {
    // The whole matrix, including every unserved value on both sides. A
    // `from === to` direction is the one shape no caller can render.
    const candidates = [...SERVED_LANGUAGES, ...UNSERVED, null];
    for (const from of candidates) {
      for (const to of candidates) {
        for (const uiLanguage of candidates) {
          const direction = decide({ q: 'año', from, to, uiLanguage });
          assert.notEqual(
            direction.from,
            direction.to,
            `from and to collapsed to ${direction.from} for ` +
              `${JSON.stringify({ from, to, uiLanguage })}`,
          );
          assert.ok(isServedLanguage(direction.from), `from ${direction.from} is not served`);
          assert.ok(isServedLanguage(direction.to), `to ${direction.to} is not served`);
        }
      }
    }
  });
});

// =============================================================================
// The async wrapper, on the paths that must not query
// =============================================================================

describe('detectLanguage skips the round trip when the answer cannot change', () => {
  // The handle points at a port nothing listens on. If these calls issued a
  // statement they would reject, so a resolved direction IS the proof that the
  // short circuit ran. The counting path is covered against a real database in
  // tests/integration/dictionary-search.test.ts.
  it('answers a stated from without touching the database', async () => {
    assert.deepEqual(await detectLanguage(db, { q: 'haus', from: 'de', uiLanguage: 'en' }), {
      from: 'de',
      to: 'en',
      detected: false,
    });
  });

  it('corrects a stated to that equals the stated from, still without a query', async () => {
    assert.deepEqual(await detectLanguage(db, { q: 'haus', from: 'de', to: 'de' }), {
      from: 'de',
      to: 'en',
      detected: false,
    });
  });

  for (const q of ['', '   ', '\n\t']) {
    it(`answers ${JSON.stringify(q)} from the UI language alone`, async () => {
      // Counting exact hits for an empty lemma is a round trip that can only
      // return nothing.
      assert.deepEqual(await detectLanguage(db, { q, uiLanguage: 'de' }), {
        from: 'en',
        to: 'de',
        detected: true,
      });
    });
  }
});
