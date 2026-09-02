/**
 * The headline claim of the Tatoeba importer: a second run writes no new rows.
 *
 * WHY ONLY A REAL DATABASE CAN PROVE THIS
 *   Idempotency here is not a property of the TypeScript. It is a property of
 *   two Postgres constraints and the `ON CONFLICT` clauses aimed at them: the
 *   unique index on `examples (source_id, external_id)`, and the composite
 *   primary key on `example_headwords (example_id, headword_id)`. Nothing but
 *   Postgres can say whether the second run's inserts were absorbed. A unit
 *   test could read the SQL and would keep passing after the constraint was
 *   dropped.
 *
 * THE PRECONDITION IS A REACHABLE DATABASE
 *   `DB_HOST` and the other `DB_*` variables, and nothing else: no API key, and
 *   no server on :3456. Every case therefore gates on `DB_HOST` alone, which is
 *   what `tests/unit/integration-tests-self-skip.test.ts` requires and what
 *   `tests/integration/dictionary-schema.test.ts` already does.
 *
 * ISOLATION, WHICH IS THE HARD PART HERE
 *   This database holds a real Wikidata import that other work depends on, and
 *   the importer's source slugs, `tatoeba` and `tatoeba-cc0`, are hardcoded
 *   constants. There is no way to scope its rows under a source of our own.
 *
 *   Worse, the fixtures are excerpts of the REAL Tatoeba dumps, so their
 *   sentence pairs are real pairs. A production import into this same database
 *   would write `examples` rows with exactly the same `(source_id, external_id)`
 *   keys. Deleting by external id, or by source id, would therefore delete rows
 *   a production import created.
 *
 *   So this file mutates nothing it did not create, and it establishes that by
 *   difference rather than by ownership:
 *
 *     1. Before the first run it records which of the FIXTURE'S OWN external
 *        ids already have an `examples` row under the two Tatoeba sources, and
 *        every `example_headwords` pair hanging from exactly those rows.
 *     2. It runs the importer twice.
 *     3. Every assertion is about the difference against those recorded sets.
 *     4. `after()` deletes exactly the ids and pairs that are in the final set
 *        and not in the first, junction rows before example rows. Never a bare
 *        delete by source id.
 *
 *   The `sources` rows themselves are NOT deleted. The importer upserts them,
 *   they are shared, and production rows may already point at them.
 *
 * THE DEFECT THIS FILE WAS REWRITTEN TO FIX: A BIND-PARAMETER OVERFLOW
 *   The first version of the baseline was scoped by SOURCE: it read every
 *   `examples` row under the two Tatoeba slugs, then fetched the junction rows
 *   with `inArray(exampleHeadwords.exampleId, [...everyId])`. One bind
 *   parameter per id. That is fine on an empty database and fatal on a real
 *   one. Against a database holding a real Tatoeba import of 99,712 example
 *   rows it produced 99,712 parameters, and the run died with
 *
 *     error: bind message has 34176 parameter formats but 0 parameters
 *
 *   The Postgres wire protocol carries the parameter count in a SIGNED 16-BIT
 *   field, so the ceiling is 65,535. Exceeding it does not raise a clean "too
 *   many parameters" error: the count WRAPS. 99,712 - 65,536 = 34,176, which is
 *   the number in the message, and the confusing "but 0 parameters" is the
 *   backend reading the wrapped remainder of a truncated message. The failure
 *   therefore reports neither the cause nor the real magnitude.
 *
 *   The new shape is immune by construction, not by being under a limit today.
 *   Every `inArray` here is over a list derived from the FIXTURE, which is
 *   fixed at 32 external ids, rather than from the DATABASE, which grows
 *   without bound. The parameter count is a property of files checked into this
 *   repository: 34 for the baseline query, at most 32 for the junction query and
 *   the cleanup delete. Importing a hundred million more sentences cannot move
 *   any of them.
 *
 *   The one query that must still see the whole source, the guard that no
 *   unexpected example row appeared, is an aggregate `COUNT(*)`. It carries two
 *   parameters, the two slugs, whatever the row count is.
 *
 * WHY THE IMPORTER IS IMPORTED CONDITIONALLY, AT THE TOP LEVEL
 *   `cli/commands/import/tatoeba.ts` reaches `drizzle/db.ts`, which constructs
 *   a pool AND starts a retrying connect the moment the module is evaluated.
 *   A plain top-level import would therefore spend about a minute failing to
 *   connect, and then reject, on a machine that set no `DB_HOST`, which is the
 *   very case every case in this directory is supposed to skip cleanly. The
 *   import is behind the same gate as the cases, so the no-database path stays
 *   silent. `CLI_MODE` is set first for the same reason it exists: it stops
 *   that module from creating host-managed indexes, which would be a write to
 *   shared state this file has no business making.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { and, count, eq, inArray, sql } from 'drizzle-orm';
import { exampleHeadwords, examples, sources } from '../../drizzle/schema';
import { DEFAULT_LANGUAGES } from '../../cli/lib/importers/contract';

const DB_HOST = process.env.DB_HOST;

if (DB_HOST) process.env.CLI_MODE = '1';

const importerModule = DB_HOST ? await import('../../cli/commands/import/tatoeba') : null;
const dbModule = DB_HOST ? await import('../../drizzle/db') : null;

/** Resolved from this module's own location, so the working directory is irrelevant. */
const FIXTURES = new URL('../fixtures/importers/', import.meta.url).pathname;

/** The two source slugs the importer hardcodes. Read-only to this file. */
const TATOEBA_SLUGS = ['tatoeba', 'tatoeba-cc0'];

/**
 * The 32 example rows the fixture link file should produce.
 *
 * Every link line whose two sentences are both in a served language and are in
 * DIFFERENT languages becomes one directed row, so the mirrored link line
 * becomes a second row. The list is written out rather than derived, because a
 * derivation here would be the importer's own filter rule repeated, and would
 * agree with a broken importer for the same wrong reason.
 */
const EXPECTED_EXTERNAL_IDS = [
  '330998:872717',
  '872717:330998',
  '330998:5783572',
  '5783572:330998',
  '331000:1608253',
  '1608253:331000',
  '331259:3778254',
  '3778254:331259',
  '334553:2838674',
  '2838674:334553',
  '334553:2838679',
  '2838679:334553',
  '495729:707430',
  '707430:495729',
  '504299:749312',
  '749312:504299',
  '504299:1731252',
  '1731252:504299',
  '552808:638743',
  '638743:552808',
  '7104384:10347104',
  '10347104:7104384',
  '8649743:8649744',
  '8649744:8649743',
  '8808232:8808241',
  '8808241:8808232',
  '8813346:10008666',
  '10008666:8813346',
  '8969693:2052750',
  '2052750:8969693',
  '7843793:7844067',
  '7844067:7843793',
];

/** One observation of the FIXTURE'S rows in the database, plus one whole-source total. */
interface Snapshot {
  /** The ids of the `examples` rows carrying one of `EXPECTED_EXTERNAL_IDS`. */
  exampleIds: Set<string>;
  /** `${exampleId}\t${headwordId}`, so a pair can live in a Set. Only pairs on those ids. */
  attachments: Set<string>;
  /** How many of `EXPECTED_EXTERNAL_IDS` are present, whoever wrote them. */
  fixtureRows: number;
  /**
   * Every `examples` row under the two Tatoeba sources, fixture or not.
   *
   * A count, never a list of ids: this is the one number that grows with the
   * database, and reading it as rows is exactly the defect described at the top
   * of this file. It exists so that a run which wrote example rows OUTSIDE the
   * fixture's external ids is still visible, which scoping to the fixture would
   * otherwise hide.
   */
  sourceTotal: number;
}

const empty: Snapshot = { exampleIds: new Set(), attachments: new Set(), fixtureRows: 0, sourceTotal: 0 };

let before1: Snapshot = empty;
let after1: Snapshot = empty;
let after2: Snapshot = empty;

/** True when a headword exists that a fixture sentence's words should match. */
let hasMatchableHeadword = false;

/**
 * Whether the baseline snapshot was taken.
 *
 * Cleanup deletes the DIFFERENCE against that baseline, so an untaken baseline
 * would make the difference the whole table and would delete rows a production
 * import wrote. If `before()` failed before the baseline existed, this file
 * deletes nothing and says so. A few leaked rows from a failed run are a much
 * smaller problem than a wrong delete, and the run already failed loudly.
 */
let baselineTaken = false;

function db() {
  assert.ok(dbModule, 'the database module was not loaded');
  return dbModule.db;
}

async function takeSnapshot(): Promise<Snapshot> {
  const handle = db();

  // Two slugs plus the fixture's 32 external ids: 34 bind parameters, on any
  // database, forever. See the bind-parameter section at the top of this file.
  const rows = await handle
    .select({ id: examples.id })
    .from(examples)
    .innerJoin(sources, eq(examples.sourceId, sources.id))
    .where(and(inArray(sources.slug, TATOEBA_SLUGS), inArray(examples.externalId, EXPECTED_EXTERNAL_IDS)));

  const exampleIds = new Set(rows.map((row) => row.id));

  // At most one parameter per row selected above, so at most 32 plus whatever a
  // duplicate across the two sources would add. Bounded by the fixture either way.
  const attachments = new Set<string>();
  if (exampleIds.size > 0) {
    const pairs = await handle
      .select({ exampleId: exampleHeadwords.exampleId, headwordId: exampleHeadwords.headwordId })
      .from(exampleHeadwords)
      .where(inArray(exampleHeadwords.exampleId, [...exampleIds]));
    for (const pair of pairs) {
      attachments.add(`${pair.exampleId}\t${pair.headwordId}`);
    }
  }

  // Two parameters, whatever the row count is.
  const totals = await handle
    .select({ value: count() })
    .from(examples)
    .innerJoin(sources, eq(examples.sourceId, sources.id))
    .where(inArray(sources.slug, TATOEBA_SLUGS));

  return { exampleIds, attachments, fixtureRows: rows.length, sourceTotal: Number(totals[0]?.value ?? 0) };
}

async function runImporter(): Promise<void> {
  assert.ok(importerModule, 'the importer module was not loaded');
  await importerModule.tatoebaImporter.run({
    file: `${FIXTURES}tatoeba-sentences.tsv`,
    links: `${FIXTURES}tatoeba-links.tsv`,
    cc0: `${FIXTURES}tatoeba-cc0.tsv`,
    languages: [...DEFAULT_LANGUAGES],
    dryRun: false,
  });
}

/**
 * Whether the database holds a headword any fixture sentence would match.
 *
 * The attachment count depends on the headword table, which this file does not
 * own and must not seed. On a database with no English headwords, zero
 * attachments is the correct answer and asserting a positive count would fail
 * for a reason that is not a defect. So the expectation is derived from what is
 * actually there.
 */
async function findMatchableHeadword(): Promise<boolean> {
  const result = await db().execute(sql`
    SELECT 1 FROM headwords
    WHERE language_code = 'en'
      AND lemma_normalized IN ('children', 'myopia', 'outdoors', 'time', 'risk')
    LIMIT 1
  `);
  return result.rows.length > 0;
}

before(async () => {
  if (!DB_HOST) return;

  before1 = await takeSnapshot();
  baselineTaken = true;
  hasMatchableHeadword = await findMatchableHeadword();

  await runImporter();
  after1 = await takeSnapshot();

  await runImporter();
  after2 = await takeSnapshot();
});

after(async () => {
  if (!DB_HOST) return;

  if (!baselineTaken) {
    console.error(
      '[importer-tatoeba-idempotency] no baseline was recorded, so nothing is deleted. ' +
        'Any rows a partial run wrote are left in place rather than risking a wrong delete.',
    );
    await dbModule?.closePool();
    return;
  }

  const handle = db();

  // Read the live state rather than trusting `after2`, so a run that failed
  // part way through still cleans up what it managed to write.
  const current = await takeSnapshot();

  // Exactly what appeared since the baseline, and nothing else. A pair can be
  // new on an example row that already existed, so the two differences are
  // taken separately. Both lists are fixture-scoped, so both deletes below
  // carry at most 32 bind parameters however large the table is.
  const newAttachments = [...current.attachments].filter((pair) => !before1.attachments.has(pair));
  const newExampleIds = [...current.exampleIds].filter((id) => !before1.exampleIds.has(id));

  // Junction rows before the rows they reference.
  for (const pair of newAttachments) {
    const [exampleId, headwordId] = pair.split('\t');
    if (exampleId === undefined || headwordId === undefined) continue;
    await handle
      .delete(exampleHeadwords)
      .where(
        sql`${exampleHeadwords.exampleId} = ${exampleId}::uuid AND ${exampleHeadwords.headwordId} = ${headwordId}::uuid`,
      );
  }

  if (newExampleIds.length > 0) {
    await handle.delete(examples).where(inArray(examples.id, newExampleIds));
  }

  // The `sources` rows are deliberately left in place. The importer upserts
  // them, they are shared, and a production import may already point at them.

  // A run may have written an example row under a Tatoeba source whose external
  // id is not in the fixture list. Such a row is outside what this file can
  // safely claim to have created, so it is REPORTED and not deleted. Deleting
  // by source would be the ownership assumption this whole file refuses.
  const residue = current.sourceTotal - newExampleIds.length - before1.sourceTotal;
  if (residue !== 0) {
    console.error(
      `[importer-tatoeba-idempotency] the Tatoeba example count moved by ${residue} rows beyond the ` +
        'fixture rows this file deleted. Those rows are left in place, because this file cannot prove it wrote them.',
    );
  }

  await dbModule?.closePool();
});

describe('a second Tatoeba import writes no new rows', () => {
  it('the first run leaves every fixture pair in the database', { skip: !DB_HOST ? 'DB_HOST not set' : false }, () => {
    // WHAT THIS PROVES, AND WHAT IT DOES NOT.
    //
    // Presence, not authorship. If a production import already held all 32
    // pairs, the first run correctly wrote nothing and they are still all here.
    // The assertion below is therefore about the state after the run, which is
    // the property the importer is responsible for either way.
    assert.equal(
      after1.fixtureRows,
      EXPECTED_EXTERNAL_IDS.length,
      'the fixture should produce one example row per directed link between two served languages',
    );
    assert.ok(after1.fixtureRows > 0, 'a run that leaves no fixture rows proves nothing');
  });

  it('the first run wrote exactly the rows that were missing', { skip: !DB_HOST ? 'DB_HOST not set' : false }, () => {
    // AND THIS ONE PROVES AUTHORSHIP, as far as it can be proven.
    //
    // New rows plus rows that were already there equals the whole fixture. On a
    // database that had never seen these pairs the first term is 32 and the
    // second is 0, which is the normal case and is not vacuous. On one where a
    // production import ran first, the terms swap, and the sum still holds.
    const created = [...after1.exampleIds].filter((id) => !before1.exampleIds.has(id));

    assert.equal(
      created.length + before1.fixtureRows,
      EXPECTED_EXTERNAL_IDS.length,
      `the first run created ${created.length} example rows on top of ${before1.fixtureRows} ` +
        'pre-existing fixture rows, which does not add up to the fixture',
    );
  });

  it('the second run creates no example row at all', { skip: !DB_HOST ? 'DB_HOST not set' : false }, () => {
    const created = [...after2.exampleIds].filter((id) => !after1.exampleIds.has(id));

    assert.deepEqual(
      created,
      [],
      'the second run inserted new example rows, so the unique index on (source_id, external_id) ' +
        'is not absorbing the re-import',
    );
    assert.equal(
      after2.exampleIds.size,
      after1.exampleIds.size,
      'the example row count moved between the two runs',
    );

    // The two assertions above are scoped to the fixture's external ids. This
    // one is not: it is the whole-source total, so a second run that invented
    // rows under some OTHER external id is caught rather than hidden by the
    // scoping. It costs two bind parameters because it is an aggregate.
    assert.equal(
      after2.sourceTotal,
      after1.sourceTotal,
      'the total number of Tatoeba example rows moved between the two runs, so the second run wrote ' +
        'example rows outside the fixture external ids',
    );
  });

  it('the second run creates no attachment at all', { skip: !DB_HOST ? 'DB_HOST not set' : false }, () => {
    const created = [...after2.attachments].filter((pair) => !after1.attachments.has(pair));

    assert.deepEqual(
      created,
      [],
      'the second run inserted new example_headwords rows, so the composite primary key on ' +
        '(example_id, headword_id) is not absorbing the re-import',
    );
    assert.equal(
      after2.attachments.size,
      after1.attachments.size,
      'the attachment count moved between the two runs',
    );
  });

  it('an example is attached whenever a headword matches its words', { skip: !DB_HOST ? 'DB_HOST not set' : false }, () => {
    // The attachment join is the half of the import that makes an example
    // reachable, and a run with zero attachments would satisfy every count
    // above while leaving every sentence invisible. Whether attachments are
    // possible depends on the headword table, which this file does not own, so
    // the expectation is read from the database rather than assumed.
    assert.equal(
      after1.attachments.size > 0,
      hasMatchableHeadword,
      hasMatchableHeadword
        ? 'headwords exist that the fixture sentences mention, but no example was attached to any of them'
        : 'no headword matches any fixture sentence, yet attachments were written',
    );
  });
});
