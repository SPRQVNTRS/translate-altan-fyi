/**
 * A Turkish headword typed on a non-Turkish keyboard, against real rows.
 *
 * WHY THIS CANNOT BE A UNIT TEST
 *   `tests/unit/locale-fold.test.ts` proves the two code paths compute the same
 *   string. It cannot prove that the string in `headwords.lemma_normalized`
 *   agrees with them, because that column was written by an earlier deploy and
 *   is rewritten by a data migration. The failure this file exists for is a
 *   folding change that ships without the rewrite: every unit test stays green
 *   and the Turkish words stop being findable.
 *
 * THIS FILE WRITES, AND THAT IS A DEPARTURE
 *   `dictionary-search.test.ts` is read-only against the shared dictionary, on
 *   purpose. This one has to insert, because it must control the exact letters
 *   under test and no imported Turkish row is guaranteed to contain them. So it
 *   does the narrowest possible version of that:
 *
 *     - ONE headword, with a lemma no import could ever produce, carrying a
 *       run-unique suffix so two concurrent runs cannot collide.
 *     - It reads an EXISTING source row for provenance and modifies nothing
 *       about it. It creates no source, no sense, no translation.
 *     - It deletes its row in a `finally`, so a failed assertion still cleans up.
 *
 *   It renames nothing, seeds nothing another test reads, and leaves no row
 *   behind for someone else's session to trip over hours from now.
 *
 * THE PRECONDITION IS `DB_HOST`, and every case self-skips without it. That is
 * what `tests/unit/integration-tests-self-skip.test.ts` requires of every file
 * in this directory, and it is why the pre-push gate can exclude them.
 */
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { drizzle } from 'drizzle-orm/node-postgres';
import { eq, inArray } from 'drizzle-orm';
import pg from 'pg';
import * as schema from '../../drizzle/schema';
import { headwords, sources } from '../../drizzle/schema';
import { searchHeadwords, type SearchHit } from '../../app/lib/dictionary/search.server';
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
 * A lemma no import could produce, carrying every letter under test.
 *
 * `Işık` is the real Turkish word ("light"), and the suffix is what makes the
 * row this run's own. `Iğdır` contributes the breve. The unique tail is a
 * random hex string rather than a timestamp, because two runs started in the
 * same millisecond must still not collide.
 */
const RUN_ID = Math.random().toString(16).slice(2, 10);
const TURKISH_LEMMA = `Işık Iğdır zzz${RUN_ID}`;

/** What a reader on an English keyboard types. No Turkish letter in it at all. */
const KEYBOARD_QUERY = `isik igdir zzz${RUN_ID}`;

after(async () => {
  await pool.end();
});

/** The lemmas of a result set, for a message that names what actually came back. */
function lemmasOf(hits: SearchHit[]): string[] {
  return hits.map((hit) => hit.lemma);
}

/**
 * Insert the temporary headword and return its id, plus the source it borrowed.
 *
 * The source is READ, never written. Any served licence will do: the search
 * joins `sources` and filters on the licence allowlist, so a row hanging off an
 * excluded source would be invisible and the test would fail for the wrong
 * reason.
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
      'existing source rather than creating one, so an empty sources table means the ' +
      'importers have not run against this database.',
  );

  const [row] = await db
    .insert(headwords)
    .values({
      languageCode: 'tr',
      lemma: TURKISH_LEMMA,
      lemmaNormalized: normalizeForLanguage(TURKISH_LEMMA, 'tr'),
      sourceId: source.id,
    })
    .returning({ id: headwords.id });

  assert.ok(row, 'the temporary headword insert returned no row');
  return row.id;
}

async function deleteTemporaryHeadword(id: string): Promise<void> {
  await db.delete(headwords).where(eq(headwords.id, id));
}

describe('Turkish search over real rows', () => {
  it(
    'finds a Turkish headword from the diacritic-free spelling an English keyboard types',
    { skip: !DB_HOST ? 'DB_HOST not set' : false },
    async () => {
      const id = await insertTemporaryHeadword();
      try {
        const hits = await searchHeadwords(db, { q: KEYBOARD_QUERY, from: 'tr', to: 'en' });
        const match = hits.find((hit) => hit.lemma === TURKISH_LEMMA);
        assert.ok(
          match,
          `"${KEYBOARD_QUERY}" did not reach "${TURKISH_LEMMA}". Hits: ` +
            `${JSON.stringify(lemmasOf(hits))}. The query and the stored column are folded by ` +
            'the same function, so a miss here means the stored side was written by different ' +
            'rules than the query side reads: check that the lemma-normalized data migration ran.',
        );
        assert.equal(
          match.matchKind,
          'exact',
          'the folded query should equal the stored form exactly, not merely resemble it',
        );
      } finally {
        await deleteTemporaryHeadword(id);
      }
    },
  );

  it(
    'finds the same row from the correctly spelled Turkish, and from the uppercase',
    { skip: !DB_HOST ? 'DB_HOST not set' : false },
    async () => {
      // The case pair is the half a locale-blind `lower()` gets wrong: it maps
      // the dotless capital I onto a dotted i and produces a different key.
      const id = await insertTemporaryHeadword();
      try {
        for (const query of [TURKISH_LEMMA, TURKISH_LEMMA.toLocaleUpperCase('tr')]) {
          const hits = await searchHeadwords(db, { q: query, from: 'tr', to: 'en' });
          assert.ok(
            hits.some((hit) => hit.lemma === TURKISH_LEMMA),
            `"${query}" did not reach "${TURKISH_LEMMA}". Hits: ${JSON.stringify(lemmasOf(hits))}`,
          );
        }
      } finally {
        await deleteTemporaryHeadword(id);
      }
    },
  );

  it(
    'holds the folded form in the column for every Turkish row already imported',
    { skip: !DB_HOST ? 'DB_HOST not set' : false },
    async () => {
      // THE CASE THAT CATCHES A MISSING DATA MIGRATION. The two above insert
      // their own row and so are green even on a table full of stale keys. This
      // one reads rows nothing in this file wrote, and recomputes what the
      // column should hold. It writes nothing.
      const rows = await db
        .select({ lemma: headwords.lemma, stored: headwords.lemmaNormalized })
        .from(headwords)
        .where(eq(headwords.languageCode, 'tr'))
        .limit(2000);

      assert.ok(
        rows.length > 0,
        'no Turkish headwords at all, so the importers have not run against this database',
      );

      const stale = rows.filter((row) => normalizeForLanguage(row.lemma, 'tr') !== row.stored);
      assert.deepEqual(
        stale.slice(0, 10),
        [],
        `${stale.length} of ${rows.length} Turkish rows hold a stored form the current fold no ` +
          'longer produces, so a search for those words finds nothing. Run ' +
          '`pnpm cli data-migration run`.',
      );
    },
  );

  it(
    'holds the folded form in the column for every German row already imported',
    { skip: !DB_HOST ? 'DB_HOST not set' : false },
    async () => {
      // German is the second language the fold changed, through `ß` to `ss`,
      // and it is the larger table. Same check, different rule.
      const rows = await db
        .select({ lemma: headwords.lemma, stored: headwords.lemmaNormalized })
        .from(headwords)
        .where(eq(headwords.languageCode, 'de'))
        .limit(2000);

      assert.ok(rows.length > 0, 'no German headwords at all');

      const stale = rows.filter((row) => normalizeForLanguage(row.lemma, 'de') !== row.stored);
      assert.deepEqual(
        stale.slice(0, 10),
        [],
        `${stale.length} of ${rows.length} German rows hold a stale stored form. Run ` +
          '`pnpm cli data-migration run`.',
      );
    },
  );
});
