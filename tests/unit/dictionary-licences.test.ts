/**
 * The licence allowlist, and the proof that it reaches the SQL.
 *
 * WHY THIS FILE EXISTS
 *   Two different failures are guarded here, and they fail in different ways.
 *
 *   1. The CONTENT of the allowlist is a legal decision (see the file comment
 *      in `app/lib/dictionary/licences.ts`). Adding a share-alike or copyleft
 *      licence would place an obligation on the whole product. This file pins
 *      the exact four ids, so such a change cannot arrive quietly inside an
 *      unrelated commit: it has to be made here too, deliberately.
 *
 *   2. The PLACEMENT of the filter is an engineering decision. The filter must
 *      be a predicate in the statement, not a `.filter()` over the rows that
 *      come back. So the assertions below read the generated SQL rather than
 *      any result: a result-shaped assertion would pass just as happily against
 *      a JavaScript filter, and would keep passing right up to the refactor
 *      that drops it. Reading the statement is the only check that can tell the
 *      two implementations apart.
 *
 * NO DATABASE IS TOUCHED. Building a Drizzle query opens no socket, and nothing
 * here is awaited. The connection string points at a port nothing listens on,
 * so an accidental await would fail loudly rather than reach a real database.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from '../../drizzle/schema';
import { SERVED_LICENCES, isServedLicence } from '../../app/lib/dictionary/licences';
import {
  findHeadwords,
  headwordFallbackLinksQuery,
  senseTranslationsQuery,
} from '../../app/lib/dictionary/queries.server';

/** Deliberately unreachable: a query that is built but never run needs no server. */
const UNREACHABLE_DSN = 'postgres://user:pass@127.0.0.1:1/none';

const db = drizzle(new pg.Pool({ connectionString: UNREACHABLE_DSN }), { schema });

/** A licence that is stored but must never be served. */
const SHARE_ALIKE = 'CC-BY-SA-4.0';
/** A copyleft licence that is stored but must never be served. */
const COPYLEFT = 'GPL-3.0-or-later';

const SAMPLE_UUID = '11111111-2222-4333-8444-555555555555';

function assertLicenceFilterIsInSql(label: string, query: { sql: string; params: unknown[] }) {
  assert.ok(
    query.sql.includes('"sources"'),
    `${label}: the statement never mentions the sources table, so it cannot be filtering on a licence.\n${query.sql}`,
  );
  assert.match(
    query.sql,
    /in \(/,
    `${label}: the statement carries no "in" predicate, so the allowlist is not applied in SQL.\n${query.sql}`,
  );
  for (const licence of SERVED_LICENCES) {
    assert.ok(
      query.params.includes(licence),
      `${label}: served licence ${licence} is missing from the bound parameters.\n${JSON.stringify(query.params)}`,
    );
  }
  assert.ok(
    !query.params.includes(SHARE_ALIKE),
    `${label}: ${SHARE_ALIKE} appears in the bound parameters. A share-alike source must never be served.`,
  );
}

describe('dictionary licence allowlist', () => {
  it('serves exactly the four approved licences', () => {
    assert.deepEqual(
      [...SERVED_LICENCES],
      ['CC0-1.0', 'CC-BY-2.0-FR', 'CC-BY-4.0', 'LLM-GENERATED'],
      'The served licence list changed. This is a legal decision, not a refactor: a licence added ' +
        'here becomes publicly served everywhere, immediately. Change this expectation only ' +
        'together with a recorded operator decision.',
    );
  });

  it('does not serve share-alike or copyleft licences', () => {
    // Kaikki/Wiktextract and WikDict are CC BY-SA; ding and Apertium are GPL.
    // They may be imported and stored, and they may never reach a reader.
    assert.equal(isServedLicence(SHARE_ALIKE), false);
    assert.equal(isServedLicence(COPYLEFT), false);
  });

  it('narrows a served licence and rejects an unknown one', () => {
    for (const licence of SERVED_LICENCES) {
      assert.equal(isServedLicence(licence), true, `${licence} should be served`);
    }
    assert.equal(isServedLicence('CC-BY-NC-4.0'), false);
    assert.equal(isServedLicence(''), false);
    assert.equal(isServedLicence('cc0-1.0'), false, 'the comparison is exact, not case folded');
  });
});

describe('the licence filter is in the SQL, not in JavaScript', () => {
  it('findHeadwords constrains sources.licence in the statement', () => {
    assertLicenceFilterIsInSql(
      'findHeadwords',
      findHeadwords(db, { languageCode: 'de', lemmaNormalized: 'laufen' }).toSQL(),
    );
  });

  it('senseTranslationsQuery constrains sources.licence in the statement', () => {
    assertLicenceFilterIsInSql(
      'senseTranslationsQuery',
      senseTranslationsQuery(db, SAMPLE_UUID).toSQL(),
    );
  });

  it('headwordFallbackLinksQuery constrains sources.licence in the statement', () => {
    assertLicenceFilterIsInSql(
      'headwordFallbackLinksQuery',
      headwordFallbackLinksQuery(db, SAMPLE_UUID).toSQL(),
    );
  });
});
