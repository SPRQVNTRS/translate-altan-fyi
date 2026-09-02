/**
 * Forgiving search, proven against the real populated dictionary.
 *
 * THIS FILE IS READ-ONLY. IT MUST STAY THAT WAY.
 *   Every other DB-backed test in this directory seeds its own rows and deletes
 *   them again. This one cannot: what it verifies is that a misspelling reaches
 *   the German word `Haus` that the importers actually loaded, and a
 *   self-seeded `Haus` would prove only that the test can insert a row. So it
 *   reads the shared dictionary and writes nothing at all.
 *
 *   The rule that follows from that is absolute: NO INSERT, NO UPDATE, NO
 *   DELETE, and no dependence on any row this file created, because it creates
 *   none. The database is shared with other sessions. Seeding or renaming a row
 *   here manufactures a defect that surfaces hours later, in someone else's
 *   work, with nothing to connect it back to this file.
 *
 * THE PRECONDITION IS A REACHABLE, POPULATED DATABASE.
 *   `DB_HOST` and the other `DB_*` variables, and nothing else: no API key and
 *   no server on :3456. Every case therefore gates on `DB_HOST` alone, which is
 *   also what `tests/unit/integration-tests-self-skip.test.ts` requires of every
 *   file in this directory. The pre-push gate starts no database, so every case
 *   here skips there.
 *
 * WHAT CASE 5 IS REALLY FOR
 *   A detected language that reaches only the chip in the header, and not the
 *   query, gives a page with correct-looking data drawn from the wrong side of
 *   the dictionary. Nothing throws and nothing looks broken. So that case does
 *   not assert on the object `detectLanguage` returns: it feeds that object into
 *   `searchHeadwords` and asserts the ROWS differ from the rows the opposite
 *   direction returns. If `from` were dropped on the way to the query, both
 *   directions would return the same rows and the case fails.
 */
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from '../../drizzle/schema';
import { detectLanguage } from '../../app/lib/dictionary/detect-language';
import { searchHeadwords, type SearchHit } from '../../app/lib/dictionary/search.server';

const DB_HOST = process.env.DB_HOST;

const pool = new pg.Pool({
  host: DB_HOST,
  port: Number(process.env.DB_PORT ?? 5432),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
});

const db = drizzle(pool, { schema });

/** A German headword the Wikidata import loads. Nothing here creates it. */
const GERMAN_LEMMA = 'Haus';
/** The same word, misspelled. This is the input the fuzzy branch exists for. */
const MISSPELLED = 'hauss';
/** An accented German headword, and the way a reader without the umlaut types it. */
const ACCENTED_LEMMA = 'über';
const UNACCENTED_QUERY = 'uber';

after(async () => {
  await pool.end();
});

/** The lemmas of a result set, for a message that names what actually came back. */
function lemmasOf(hits: SearchHit[]): string[] {
  return hits.map((hit) => hit.lemma);
}

/** A comparable fingerprint of a result set: lemma and language, in order. */
function fingerprintOf(hits: SearchHit[]): string[] {
  return hits.map((hit) => `${hit.languageCode}:${hit.lemma}`);
}

describe('forgiving search over the populated dictionary', () => {
  it(
    'reaches Haus from the misspelling hauss',
    { skip: !DB_HOST ? 'DB_HOST not set' : false },
    async () => {
      const hits = await searchHeadwords(db, { q: MISSPELLED, from: 'de', to: 'en' });
      assert.ok(
        hits.some((hit) => hit.lemma === GERMAN_LEMMA),
        `expected ${GERMAN_LEMMA} among the hits for "${MISSPELLED}", got: ` +
          `${JSON.stringify(lemmasOf(hits))}. If the list is empty, either the German import ` +
          'has not run against this database or the trigram predicate is gone.',
      );
      const match = hits.find((hit) => hit.lemma === GERMAN_LEMMA);
      assert.ok(match);
      assert.equal(match.matchKind, 'fuzzy', 'a misspelling is not an exact match');
      assert.ok(
        match.similarity > 0.35,
        `the hit came back below the threshold it was selected by: ${match.similarity}`,
      );
    },
  );

  it(
    'reaches über from the unaccented query uber',
    { skip: !DB_HOST ? 'DB_HOST not set' : false },
    async () => {
      const hits = await searchHeadwords(db, { q: UNACCENTED_QUERY, from: 'de', to: 'en' });
      assert.ok(
        hits.some((hit) => hit.lemma === ACCENTED_LEMMA),
        `expected ${ACCENTED_LEMMA} among the hits for "${UNACCENTED_QUERY}", got: ` +
          `${JSON.stringify(lemmasOf(hits))}. The accent is removed by normalizeForLanguage on ` +
          'the query side and was removed by the same function on import, so this is the check ' +
          'that the two sides still agree.',
      );
    },
  );

  it(
    'puts the exact hit ahead of every fuzzy one',
    { skip: !DB_HOST ? 'DB_HOST not set' : false },
    async () => {
      const hits = await searchHeadwords(db, { q: GERMAN_LEMMA, from: 'de', to: 'en' });
      assert.ok(hits.length > 0, `no hits at all for ${GERMAN_LEMMA}`);
      const [first] = hits;
      assert.ok(first);
      assert.equal(
        first.matchKind,
        'exact',
        `the first hit for ${GERMAN_LEMMA} is a fuzzy one: ${JSON.stringify(lemmasOf(hits))}`,
      );
      const firstFuzzy = hits.findIndex((hit) => hit.matchKind === 'fuzzy');
      const lastExact = hits.findLastIndex((hit) => hit.matchKind === 'exact');
      assert.ok(
        firstFuzzy === -1 || firstFuzzy > lastExact,
        `a fuzzy hit at ${firstFuzzy} sits ahead of an exact one at ${lastExact}: ` +
          JSON.stringify(hits.map((hit) => `${hit.matchKind}:${hit.lemma}`)),
      );
    },
  );

  it(
    'returns only headwords of the language it was asked for',
    { skip: !DB_HOST ? 'DB_HOST not set' : false },
    async () => {
      const hits = await searchHeadwords(db, { q: GERMAN_LEMMA, from: 'de', to: 'en' });
      assert.ok(hits.length > 0, `no hits at all for ${GERMAN_LEMMA}`);
      assert.ok(
        hits.every((hit) => hit.languageCode === 'de'),
        'a non-German headword reached a German-directed search: ' +
          JSON.stringify(fingerprintOf(hits)),
      );
    },
  );

  it(
    'threads the DETECTED direction into the query, not just into the label',
    { skip: !DB_HOST ? 'DB_HOST not set' : false },
    async () => {
      // No `from` in the parameters, so the direction is genuinely detected.
      const direction = await detectLanguage(db, { q: GERMAN_LEMMA, uiLanguage: 'en' });
      assert.equal(direction.detected, true, 'the direction was stated, not detected');
      assert.equal(
        direction.from,
        'de',
        `expected ${GERMAN_LEMMA} to be detected as German, got ${direction.from}`,
      );
      const detectedHits = await searchHeadwords(db, {
        q: GERMAN_LEMMA,
        from: direction.from,
        to: direction.to,
      });
      assert.ok(detectedHits.length > 0, 'the detected direction returned nothing');
      assert.ok(
        detectedHits.every((hit) => hit.languageCode === direction.from),
        `a headword outside ${direction.from} reached the detected search: ` +
          JSON.stringify(fingerprintOf(detectedHits)),
      );
      // The discriminating half. Searching the SAME text in the opposite
      // direction must not produce the same rows. If `from` were accepted and
      // then dropped on the way to the statement, both calls would return the
      // identical list and every assertion above would still pass.
      const oppositeHits = await searchHeadwords(db, {
        q: GERMAN_LEMMA,
        from: direction.to,
        to: direction.from,
      });
      assert.notDeepEqual(
        fingerprintOf(oppositeHits),
        fingerprintOf(detectedHits),
        `searching ${GERMAN_LEMMA} as ${direction.to} returned exactly the same rows as ` +
          `searching it as ${direction.from}. The direction is not reaching the query.`,
      );
      assert.ok(
        oppositeHits.every((hit) => hit.languageCode === direction.to),
        `a headword outside ${direction.to} reached the reversed search: ` +
          JSON.stringify(fingerprintOf(oppositeHits)),
      );
    },
  );
});
