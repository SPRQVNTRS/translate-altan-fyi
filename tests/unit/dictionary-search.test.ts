/**
 * The search statements, read as SQL.
 *
 * WHY THE ASSERTIONS READ THE STATEMENT AND NOT A RESULT
 *   Three properties of the fuzzy branch are invisible to a result-shaped
 *   test, and each of them fails silently when it breaks.
 *
 *   1. The 0.35 threshold. If the explicit `similarity(...) > 0.35` comparison
 *      is dropped, the `%` operator still returns rows, so nothing looks
 *      broken. The threshold then quietly becomes the session GUC
 *      `pg_trgm.similarity_threshold`, default 0.3, which is a WIDER net than
 *      this product asked for, and which nothing in this repository sets.
 *   2. The `%` operator. Drop it and the query still returns the right rows,
 *      and it returns them by scanning the whole table for every keystroke.
 *      A correctness test cannot see the difference. Only the statement can.
 *   3. The licence allowlist. A JavaScript `.filter()` over the returned rows
 *      would satisfy any assertion about the rows, right up to the refactor
 *      that drops it.
 *
 * NO DATABASE IS TOUCHED. Building a Drizzle query opens no socket, and every
 * statement here is built and never run. The connection string points at a port
 * nothing listens on, so an accidental await fails loudly instead of reaching a
 * real database.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from '../../drizzle/schema';
import { SERVED_LICENCES } from '../../app/lib/dictionary/licences';
import {
  SIMILARITY_THRESHOLD,
  exactHeadwordsQuery,
  fuzzyHeadwordsQuery,
  searchHeadwords,
} from '../../app/lib/dictionary/search.server';

/** Deliberately unreachable: a query that is built but never run needs no server. */
const UNREACHABLE_DSN = 'postgres://user:pass@127.0.0.1:1/none';

const db = drizzle(new pg.Pool({ connectionString: UNREACHABLE_DSN }), { schema });

/** A misspelling, which is the input the fuzzy branch exists for. */
const MISSPELLED = 'hauss';
/** A licence that is stored but must never be served. */
const SHARE_ALIKE = 'CC-BY-SA-4.0';
const SAMPLE_UUID = '11111111-2222-4333-8444-555555555555';

function fuzzySql() {
  return fuzzyHeadwordsQuery(db, {
    normalizedQuery: MISSPELLED,
    from: 'de',
    limit: 20,
    excludeIds: [SAMPLE_UUID],
  }).toSQL();
}

function exactSql() {
  return exactHeadwordsQuery(db, { normalizedQuery: 'haus', from: 'de', limit: 20 }).toSQL();
}

describe('the fuzzy branch carries its threshold in the statement', () => {
  it('binds SIMILARITY_THRESHOLD as a parameter or writes it as a literal', () => {
    const query = fuzzySql();
    const isBound = query.params.includes(SIMILARITY_THRESHOLD);
    const isLiteral = query.sql.includes(String(SIMILARITY_THRESHOLD));
    assert.ok(
      isBound || isLiteral,
      'The 0.35 threshold reaches neither the parameters nor the statement text. Without it ' +
        'the effective threshold is the session GUC pg_trgm.similarity_threshold, default 0.3, ' +
        `which nothing in this repository sets.\n${query.sql}\n${JSON.stringify(query.params)}`,
    );
  });

  it('compares against the normalized lemma column', () => {
    const query = fuzzySql();
    assert.match(
      query.sql,
      /similarity\("headwords"\."lemma_normalized",/,
      `the similarity is not computed over headwords.lemma_normalized.\n${query.sql}`,
    );
    assert.ok(
      query.params.includes(MISSPELLED),
      `the normalized query is not among the bound parameters.\n${JSON.stringify(query.params)}`,
    );
  });

  it('keeps the % operator, which is what makes it an index scan', () => {
    const query = fuzzySql();
    assert.match(
      query.sql,
      /"headwords"\."lemma_normalized" % /,
      'The % operator is gone. It is the only predicate headwords_lemma_normalized_trgm_idx ' +
        'can answer, so without it every keystroke reads the whole table. The rows come back ' +
        `either way, which is why no result-shaped test can catch this.\n${query.sql}`,
    );
  });

  it('orders by descending similarity, then by lemma', () => {
    const query = fuzzySql();
    assert.match(
      query.sql,
      /order by similarity\([^)]*\) desc, "headwords"\."lemma" asc/,
      `expected similarity desc then lemma asc.\n${query.sql}`,
    );
  });

  it('excludes the ids the exact branch already served', () => {
    const query = fuzzySql();
    assert.match(query.sql, /"headwords"\."id" not in \(/, query.sql);
    assert.ok(query.params.includes(SAMPLE_UUID), JSON.stringify(query.params));
  });

  it('omits the exclusion entirely when there is nothing to exclude', () => {
    // `not in ()` is not valid SQL, so the predicate must be absent rather than
    // empty when the exact branch returned nothing.
    const query = fuzzyHeadwordsQuery(db, {
      normalizedQuery: MISSPELLED,
      from: 'de',
      limit: 20,
      excludeIds: [],
    }).toSQL();
    assert.ok(!query.sql.includes('not in'), query.sql);
  });
});

describe('both search branches filter the licence in SQL', () => {
  for (const [label, build] of [
    ['fuzzy', fuzzySql],
    ['exact', exactSql],
  ] as const) {
    it(`${label}: constrains sources.licence in the statement`, () => {
      const query = build();
      assert.ok(
        query.sql.includes('"sources"'),
        `${label}: the statement never mentions the sources table, so it cannot be filtering ` +
          `on a licence.\n${query.sql}`,
      );
      assert.match(
        query.sql,
        /"sources"\."licence" in \(/,
        `${label}: the allowlist is not applied in SQL.\n${query.sql}`,
      );
      for (const licence of SERVED_LICENCES) {
        assert.ok(
          query.params.includes(licence),
          `${label}: served licence ${licence} is missing from the bound parameters.\n` +
            JSON.stringify(query.params),
        );
      }
      assert.ok(
        !query.params.includes(SHARE_ALIKE),
        `${label}: ${SHARE_ALIKE} appears in the bound parameters. A share-alike source must ` +
          'never be served.',
      );
    });
  }

  it('both branches restrict the searched language', () => {
    assert.match(fuzzySql().sql, /"headwords"\."language_code" = /);
    assert.match(exactSql().sql, /"headwords"\."language_code" = /);
  });
});

describe('an empty query never reaches the database', () => {
  // The database handle points at a port nothing listens on. If these calls
  // issued a statement they would reject, so a resolved empty array IS the
  // proof that the short circuit ran.
  // Only whitespace, which normalizes to the empty string. Punctuation does
  // NOT: `normalizeLemma` keeps it, so a query of "!!!" is a real lookup that
  // finds nothing, not a short circuit.
  for (const q of ['', '   ', '\n\t']) {
    it(`returns [] for ${JSON.stringify(q)} without a round trip`, async () => {
      assert.deepEqual(await searchHeadwords(db, { q, from: 'de', to: 'en' }), []);
    });
  }

  it('returns [] for a non-positive limit', async () => {
    assert.deepEqual(await searchHeadwords(db, { q: 'haus', from: 'de', to: 'en', limit: 0 }), []);
  });
});
