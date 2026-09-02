/**
 * The dictionary schema, proven against a real Postgres.
 *
 * WHY A DB-BACKED TEST AT ALL
 *   Four of the guarantees this milestone rests on are enforced by the database
 *   and by nothing else: the NOT NULL on `source_id`, the CHECK that a
 *   translation joins two different senses, the trigram index behind search,
 *   and the fact that the licence predicate is a real SQL filter rather than a
 *   comment. A unit test can read the query text; only Postgres can say whether
 *   the constraint exists and bites.
 *
 * SELF-SKIPPING
 *   The pre-push gate does not start a database, so every case here skips
 *   without the environment. See `tests/unit/integration-tests-self-skip.test.ts`,
 *   which enforces that property for every file in this directory.
 *
 * ISOLATION
 *   Every row this file creates carries a run-scoped random suffix, and every
 *   row is deleted again in `after()`, in foreign-key-safe order. Nothing
 *   pre-existing is read, written, or deleted, and the seeded `languages` rows
 *   are only ever referenced.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { inArray, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from '../../drizzle/schema';
import {
  entryAliases,
  headwords,
  senseVersions,
  senses,
  sources,
  translations,
} from '../../drizzle/schema';
import {
  createEntryLookups,
  findHeadwords,
  resolveEntry,
} from '../../app/lib/dictionary/queries.server';

const DB_HOST = process.env.DB_HOST;
const TEST_API_KEY = process.env.TEST_API_KEY;

const pool = new pg.Pool({
  host: DB_HOST,
  port: Number(process.env.DB_PORT ?? 5432),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
});

const db = drizzle(pool, { schema });

/** Every row this run creates carries this suffix, so cleanup can be exact. */
const RUN = randomUUID().slice(0, 8);
/** A language the migration seeds. Referenced only, never modified. */
const LANGUAGE = 'en';

/** The ids this run creates, so `after()` can delete exactly them and nothing else. */
interface CreatedIds {
  sourceIds: string[];
  aliasIds: string[];
}

const created: CreatedIds = { sourceIds: [], aliasIds: [] };

let openSourceId = '';
let shareAlikeSourceId = '';
let openSenseId = '';

/** The lemma both the served and the unserved headword share, so only licence differs. */
const SHARED_LEMMA = `zzruntest${RUN}`;

function isConfigured(): boolean {
  return Boolean(DB_HOST) && Boolean(TEST_API_KEY);
}

/**
 * Run a statement that is expected to fail, and hand back the error.
 *
 * Asserting on the error text, rather than on the mere fact that something
 * threw, is the point: a typo in the SQL also throws, and would make a
 * constraint test pass while proving nothing about the constraint.
 */
async function captureError(run: () => Promise<void>): Promise<Error> {
  try {
    await run();
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
  throw new Error('The statement was expected to be rejected, but it succeeded.');
}

async function insertSource(slug: string, licence: string): Promise<string> {
  const [row] = await db
    .insert(sources)
    .values({
      slug: `${slug}-${RUN}`,
      name: `test source ${RUN}`,
      licence,
      attribution: `test run ${RUN}`,
    })
    .returning({ id: sources.id });
  assert.ok(row, 'failed to create the test source');
  created.sourceIds.push(row.id);
  return row.id;
}

before(async () => {
  if (!isConfigured()) return;

  openSourceId = await insertSource('test-open', 'CC0-1.0');
  shareAlikeSourceId = await insertSource('test-share-alike', 'CC-BY-SA-4.0');

  // Same lemma, different part of speech: the unique constraint is on
  // (language, lemma, pos), so the pair differs only by the licence of its
  // source, which is exactly what case 3 needs to isolate.
  const [openHeadword] = await db
    .insert(headwords)
    .values({
      languageCode: LANGUAGE,
      lemma: SHARED_LEMMA,
      lemmaNormalized: SHARED_LEMMA,
      pos: 'noun',
      sourceId: openSourceId,
    })
    .returning({ id: headwords.id });
  assert.ok(openHeadword, 'failed to create the served headword');

  const [shareAlikeHeadword] = await db
    .insert(headwords)
    .values({
      languageCode: LANGUAGE,
      lemma: SHARED_LEMMA,
      lemmaNormalized: SHARED_LEMMA,
      pos: 'verb',
      sourceId: shareAlikeSourceId,
    })
    .returning({ id: headwords.id });
  assert.ok(shareAlikeHeadword, 'failed to create the unserved headword');

  const [sense] = await db
    .insert(senses)
    .values({ headwordId: openHeadword.id, sourceId: openSourceId })
    .returning({ id: senses.id });
  assert.ok(sense, 'failed to create the test sense');
  openSenseId = sense.id;
});

after(async () => {
  if (!isConfigured()) {
    await pool.end();
    return;
  }

  // Foreign-key-safe order: edges, then versions, then senses, then headwords,
  // then the sources everything points at.
  if (created.aliasIds.length > 0) {
    await db.delete(entryAliases).where(inArray(entryAliases.retiredId, created.aliasIds));
  }
  if (created.sourceIds.length > 0) {
    await db.delete(translations).where(inArray(translations.sourceId, created.sourceIds));
    await db.delete(senseVersions).where(inArray(senseVersions.sourceId, created.sourceIds));
    await db.delete(senses).where(inArray(senses.sourceId, created.sourceIds));
    await db.delete(headwords).where(inArray(headwords.sourceId, created.sourceIds));
    await db.delete(sources).where(inArray(sources.id, created.sourceIds));
  }

  await pool.end();
});

describe('dictionary schema', () => {
  it('rejects a headword with no source', { skip: !DB_HOST || !TEST_API_KEY ? 'DB_HOST or TEST_API_KEY not set' : false }, async () => {
    // Written as raw SQL because the Drizzle types make the omission
    // impossible to express, and the point of the case is the database's
    // answer rather than the compiler's.
    const lemma = `zznosource${RUN}`;
    const error = await captureError(async () => {
      await db.execute(
        sql`insert into headwords (language_code, lemma, lemma_normalized) values (${LANGUAGE}, ${lemma}, ${lemma})`,
      );
    });

    assert.match(
      error.message,
      /source_id/,
      `expected the rejection to name source_id, got: ${error.message}`,
    );
    assert.match(
      error.message,
      /not-null|null value/i,
      `expected a NOT NULL violation, got: ${error.message}`,
    );
  });

  it('rejects a translation whose two senses are the same', { skip: !DB_HOST || !TEST_API_KEY ? 'DB_HOST or TEST_API_KEY not set' : false }, async () => {
    const error = await captureError(async () => {
      await db
        .insert(translations)
        .values({ fromSenseId: openSenseId, toSenseId: openSenseId, sourceId: openSourceId });
    });

    assert.match(
      error.message,
      /translations_distinct_senses_check/,
      `expected the CHECK constraint by name, got: ${error.message}`,
    );
  });

  it('hides an unserved licence and returns the served row with the same lemma', { skip: !DB_HOST || !TEST_API_KEY ? 'DB_HOST or TEST_API_KEY not set' : false }, async () => {
    const rows = await findHeadwords(db, {
      languageCode: LANGUAGE,
      lemmaNormalized: SHARED_LEMMA,
    });

    assert.equal(rows.length, 1, `expected exactly the CC0 row, got ${rows.length}`);
    const [row] = rows;
    assert.ok(row);
    assert.equal(row.sourceLicence, 'CC0-1.0');
    assert.equal(row.pos, 'noun');
    assert.ok(
      rows.every((candidate) => candidate.sourceId !== shareAlikeSourceId),
      'a CC-BY-SA-4.0 row reached the result set',
    );
  });

  it('has the trigram index behind lemma search', { skip: !DB_HOST || !TEST_API_KEY ? 'DB_HOST or TEST_API_KEY not set' : false }, async () => {
    const result = await db.execute(
      sql`select indexdef from pg_indexes where indexname = 'headwords_lemma_normalized_trgm_idx'`,
    );

    assert.equal(result.rows.length, 1, 'headwords_lemma_normalized_trgm_idx does not exist');
    const definition = String(result.rows[0]?.indexdef ?? '');
    assert.match(definition, /gin/i, `expected a gin index, got: ${definition}`);
    assert.match(definition, /gin_trgm_ops/i, `expected gin_trgm_ops, got: ${definition}`);
  });

  it('redirects a retired id and reports an unknown one as missing', { skip: !DB_HOST || !TEST_API_KEY ? 'DB_HOST or TEST_API_KEY not set' : false }, async () => {
    const retiredId = randomUUID();
    await db.insert(entryAliases).values({
      retiredId,
      replacementId: openSenseId,
      entity: 'sense',
      reason: `test run ${RUN}`,
    });
    created.aliasIds.push(retiredId);

    const lookups = createEntryLookups(db);

    assert.deepEqual(await resolveEntry(lookups, retiredId), {
      kind: 'redirect',
      replacementId: openSenseId,
    });
    assert.deepEqual(await resolveEntry(lookups, randomUUID()), { kind: 'missing' });
    assert.deepEqual(await resolveEntry(lookups, openSenseId), {
      kind: 'found',
      entity: 'sense',
      id: openSenseId,
    });
  });
});
