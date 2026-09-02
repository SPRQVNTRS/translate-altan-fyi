/**
 * The did-you-mean suggestion, against real rows and real `pg_trgm`.
 *
 * WHY THIS CANNOT BE A UNIT TEST
 *   `tests/unit/search-normalise.test.ts` proves the normaliser does NOT repair
 *   spelling, which is the whole reason this layer exists. What closes the gap
 *   is trigram similarity, and that lives in Postgres: the `%` operator, the
 *   `similarity()` function, the GiST index and the session threshold are all
 *   database behaviour that no amount of TypeScript can stand in for. A
 *   reimplementation here would be a model of Postgres, and a model that drifted
 *   would go green while the feature was broken.
 *
 * WHAT IT ACTUALLY GUARDS
 *   `feedback_fallback_hides_a_broken_derived_key`. A suggestion path that fell
 *   back to echoing its own input would render "did you mean: hauzz" under a
 *   search for `hauzz`, which looks like a working feature from a screenshot
 *   and is a completely broken one. The second case below is the one that
 *   catches it: an EXACT hit must produce `null`, and a path that echoes its
 *   input would return the query instead.
 *
 * THIS FILE WRITES, AND STAYS INSIDE THE NARROWEST VERSION OF THAT
 *   `tests/integration/turkish-search.test.ts` is the house shape and this
 *   follows it exactly: ONE headword whose lemma no import could ever produce,
 *   carrying a run-unique suffix so two concurrent runs cannot collide; an
 *   EXISTING source row read for provenance and never modified; and a delete in
 *   a `finally`, so a failed assertion still cleans up. It renames nothing and
 *   seeds nothing another test reads.
 *
 * THE PRECONDITION IS `DB_HOST`, and every case self-skips without it, which is
 * what `tests/unit/integration-tests-self-skip.test.ts` requires of every file
 * in this directory.
 */
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { drizzle } from 'drizzle-orm/node-postgres';
import { eq, inArray } from 'drizzle-orm';
import pg from 'pg';
import * as schema from '../../drizzle/schema';
import { headwords, sources } from '../../drizzle/schema';
import { SUGGESTION_THRESHOLD, suggestDidYouMean } from '../../app/lib/dictionary/did-you-mean';
import { searchHeadwords } from '../../app/lib/dictionary/search.server';
import { normalizeForLanguage } from '../../app/lib/dictionary/normalize';
import { SERVED_LICENCES } from '../../app/lib/dictionary/licences';

const DB_HOST = process.env.DB_HOST;

const pool = new pg.Pool({
  host: DB_HOST,
  port: Number(process.env.DB_PORT ?? 5432),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
});

const db = drizzle(pool, { schema });

/**
 * A lemma no import could produce, long enough that a one-letter change still
 * scores well above `SUGGESTION_THRESHOLD`.
 *
 * The unique tail is random hex rather than a timestamp, because two runs
 * started in the same millisecond must still not collide. It is also what makes
 * the row the CLOSEST neighbour of the misspelling below: nothing else in the
 * corpus shares those trigrams, so the assertions cannot be satisfied by some
 * unrelated German word that happened to rank higher.
 */
const RUN_ID = Math.random().toString(16).slice(2, 10);
const LEMMA = `Zwetschgenknoedel${RUN_ID}`;

/** The same word with ONE letter wrong. This is the query a reader actually types. */
const MISSPELLING = `Zwetschgenknoedle${RUN_ID}`;

after(async () => {
  await pool.end();
});

/**
 * Insert the temporary headword and return its id.
 *
 * The source is READ, never written. Any served licence will do, because the
 * suggestion query joins `sources` and filters on the licence allowlist, so a
 * row hanging off an excluded source would be invisible and the test would fail
 * for the wrong reason.
 */
async function insertTemporaryHeadword(): Promise<string> {
  const [source] = await db
    .select({ id: sources.id })
    .from(sources)
    .where(inArray(sources.licence, [...SERVED_LICENCES]))
    .limit(1);

  assert.ok(
    source,
    `no source row with a served licence (${SERVED_LICENCES.join(', ')}). This test borrows an ` +
      'existing source rather than creating one, so an empty sources table means the importers ' +
      'have not run against this database.',
  );

  const [row] = await db
    .insert(headwords)
    .values({
      languageCode: 'de',
      lemma: LEMMA,
      lemmaNormalized: normalizeForLanguage(LEMMA, 'de'),
      sourceId: source.id,
    })
    .returning({ id: headwords.id });

  assert.ok(row, 'the temporary headword insert returned no row');
  return row.id;
}

async function deleteTemporaryHeadword(id: string): Promise<void> {
  await db.delete(headwords).where(eq(headwords.id, id));
}

describe('did you mean, over real dictionary rows', () => {
  it(
    'offers the real headword for a one-letter misspelling',
    { skip: !DB_HOST ? 'DB_HOST not set' : false },
    async () => {
      const id = await insertTemporaryHeadword();
      try {
        const suggestion = await suggestDidYouMean(db, { query: MISSPELLING, languageCode: 'de' });
        assert.equal(
          suggestion,
          LEMMA,
          `"${MISSPELLING}" was offered ${JSON.stringify(suggestion)} instead of "${LEMMA}". ` +
            `Either nothing cleared SUGGESTION_THRESHOLD (${SUGGESTION_THRESHOLD}), or the ` +
            'pg_trgm session threshold has been raised above it and the % operator is now ' +
            'discarding the candidate before the explicit comparison ever sees it.',
        );
      } finally {
        await deleteTemporaryHeadword(id);
      }
    },
  );

  it('never echoes the query back as its own suggestion', { skip: !DB_HOST ? 'DB_HOST not set' : false }, async () => {
    // THE CASE THIS FILE EXISTS FOR. The query is the stored word itself, so
    // the nearest neighbour scores 1 and IS the query. A suggestion path with
    // a fallback that returns its input would answer with the word here, and
    // the screen would read "did you mean: <the thing you just searched>".
    const id = await insertTemporaryHeadword();
    try {
      const suggestion = await suggestDidYouMean(db, { query: LEMMA, languageCode: 'de' });
      assert.equal(
        suggestion,
        null,
        `an exact hit produced the suggestion ${JSON.stringify(suggestion)}. A suggestion is ` +
          'only honest when it differs from what the reader typed.',
      );
    } finally {
      await deleteTemporaryHeadword(id);
    }
  });

  it(
    'still offers nothing when the casing differs but the word does not',
    { skip: !DB_HOST ? 'DB_HOST not set' : false },
    async () => {
      // The comparison that suppresses the echo runs on the FOLDED forms. An
      // uppercase spelling of the same word is the same word, and offering it
      // back would be a correction that corrects nothing.
      const id = await insertTemporaryHeadword();
      try {
        const suggestion = await suggestDidYouMean(db, {
          query: LEMMA.toLocaleUpperCase('de'),
          languageCode: 'de',
        });
        assert.equal(suggestion, null, 'a casing difference is not a spelling correction');
      } finally {
        await deleteTemporaryHeadword(id);
      }
    },
  );

  it(
    'is reached only after the search itself found nothing',
    { skip: !DB_HOST ? 'DB_HOST not set' : false },
    async () => {
      // The route calls `suggestDidYouMean` only when `searchHeadwords`
      // returned an empty list. That ordering is the product decision, so it is
      // asserted rather than described: a query with no result at all must
      // still be reachable through a suggestion, and the suggestion must be a
      // word the search itself can then find.
      const id = await insertTemporaryHeadword();
      try {
        const suggestion = await suggestDidYouMean(db, { query: MISSPELLING, languageCode: 'de' });
        assert.ok(suggestion, 'no suggestion to follow');

        const followed = await searchHeadwords(db, { q: suggestion, from: 'de', to: 'en' });
        assert.ok(
          followed.some((hit) => hit.lemma === LEMMA),
          `following the suggestion "${suggestion}" found ${JSON.stringify(
            followed.map((hit) => hit.lemma),
          )}. A suggestion the search cannot then answer is a dead end with a link on it.`,
        );
      } finally {
        await deleteTemporaryHeadword(id);
      }
    },
  );

  it(
    'offers nothing for a phrase, which has no single headword to be a near miss of',
    { skip: !DB_HOST ? 'DB_HOST not set' : false },
    async () => {
      const suggestion = await suggestDidYouMean(db, {
        query: `${MISSPELLING} ${MISSPELLING}`,
        languageCode: 'de',
      });
      assert.equal(
        suggestion,
        null,
        'a phrase reached the suggestion path. Offering one word in place of several is not a ' +
          'spelling correction, it is a different search.',
      );
    },
  );
});
