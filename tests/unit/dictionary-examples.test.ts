/**
 * Which example sentence a reader is shown, and where its credit points.
 *
 * THE DEFECT THIS FILE EXISTS FOR
 *   A lookup of the German `Haus` with English as the target language showed
 *   `Das ist sein Haus. / Ésta es su casa.` The Spanish translation was a real
 *   row, correctly licensed and correctly attached. It was simply not an answer
 *   to the question the reader asked. Nothing threw, nothing looked broken, and
 *   no assertion about hits, licences or row counts could see it.
 *
 * WHY HALF THE CASES READ SQL AND THE OTHER HALF READ VALUES
 *   The fix has two halves that fail independently. The ordering lives in the
 *   statement, because the row budget is spent by the database: drop it and the
 *   preferred rows are never FETCHED, so no amount of JavaScript can show them.
 *   The selection lives in `collectExamples`, because a fetched row still has to
 *   be chosen: drop it and an off-language row that arrived anyway is rendered.
 *   A test of one half passes while the other is missing, so both are tested.
 *
 * NO DATABASE IS TOUCHED. Building a Drizzle query opens no socket, and the
 * connection string points at a port nothing listens on, so an accidental await
 * fails loudly instead of reaching a real database.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from '../../drizzle/schema';
import { SERVED_LICENCES } from '../../app/lib/dictionary/licences';
import { licenceLabel, sourceRecordUrl } from '../../app/lib/dictionary/source-urls';
import {
  collectExamples,
  directExamplesQuery,
  junctionExamplesQuery,
  type ExampleRow,
} from '../../app/lib/dictionary/search.server';
import {
  entryDirectExamplesQuery,
  entryJunctionExamplesQuery,
} from '../../app/lib/dictionary/entry.server';

/** Deliberately unreachable: a query that is built but never run needs no server. */
const UNREACHABLE_DSN = 'postgres://user:pass@127.0.0.1:1/none';

const db = drizzle(new pg.Pool({ connectionString: UNREACHABLE_DSN }), { schema });

const SAMPLE_UUID = '11111111-2222-4333-8444-555555555555';
const OTHER_UUID = '99999999-8888-4777-8666-555555555555';
/** The language the reader is translating into, in every case below. */
const TARGET = 'en';

/** The four statements that fetch example sentences, each named for its message. */
const exampleStatements = [
  {
    name: 'junctionExamplesQuery',
    sql: () => junctionExamplesQuery(db, { headwordIds: [SAMPLE_UUID], to: TARGET }).toSQL(),
  },
  {
    name: 'directExamplesQuery',
    sql: () => directExamplesQuery(db, { headwordIds: [SAMPLE_UUID], to: TARGET }).toSQL(),
  },
  {
    name: 'entryJunctionExamplesQuery',
    sql: () => entryJunctionExamplesQuery(db, { headwordId: SAMPLE_UUID, to: TARGET }).toSQL(),
  },
  {
    name: 'entryDirectExamplesQuery',
    sql: () =>
      entryDirectExamplesQuery(db, {
        headwordId: SAMPLE_UUID,
        senseIds: [OTHER_UUID],
        to: TARGET,
      }).toSQL(),
  },
];

/** One row of an example query, with only the fields a case varies spelled out. */
function exampleRow(overrides: Partial<ExampleRow> & { id: string }): ExampleRow {
  return {
    headwordId: SAMPLE_UUID,
    text: 'Das ist sein Haus.',
    languageCode: 'de',
    translationText: 'This is his house.',
    translationLanguageCode: 'en',
    externalId: null,
    sourceSlug: 'tatoeba',
    sourceName: 'Tatoeba',
    sourceLicence: 'CC-BY-2.0-FR',
    ...overrides,
  };
}

describe('the example statements carry the target language', () => {
  for (const statement of exampleStatements) {
    it(`${statement.name} orders by a target-language preference`, () => {
      const query = statement.sql();
      assert.ok(
        query.sql.toLowerCase().includes('case when'),
        `${statement.name} builds no language preference into its ordering. The row limit is ` +
          'then spent on whatever sorts first by id, so the sentences translated into the ' +
          `reader's language are never fetched. Statement: ${query.sql}`,
      );
    });

    it(`${statement.name} puts the target language itself in the statement`, () => {
      const query = statement.sql();
      const isBound = query.params.includes(TARGET);
      const isLiteral = query.sql.includes(`'${TARGET}'`);
      assert.ok(
        isBound || isLiteral,
        `${statement.name} accepts a target language and then drops it before the statement. ` +
          'A preference expression that compares against nothing orders every row the same ' +
          `way, which is no ordering at all. Parameters: ${JSON.stringify(query.params)}`,
      );
    });
  }
});

describe('collectExamples prefers the target language', () => {
  it('drops the off-language rows when the headword has target-language ones', () => {
    const rows = [
      exampleRow({ id: 'a', translationLanguageCode: 'es', translationText: 'Ésta es su casa.' }),
      exampleRow({ id: 'b', translationLanguageCode: 'en' }),
    ];
    const kept = collectExamples(rows, 5, 'en').get(SAMPLE_UUID) ?? [];
    assert.deepEqual(
      kept.map((example) => example.translationLanguageCode),
      ['en'],
      'a Spanish translation was served under an English lookup while an English one was ' +
        'available. This is the reported defect, exactly.',
    );
  });

  it('still serves an off-language row when the headword has nothing better', () => {
    const rows = [
      exampleRow({ id: 'a', translationLanguageCode: 'es', translationText: 'Ésta es su casa.' }),
    ];
    const kept = collectExamples(rows, 5, 'en').get(SAMPLE_UUID) ?? [];
    assert.equal(
      kept.length,
      1,
      'the preference became a filter and emptied the examples of a headword that simply has ' +
        'no English translation yet. One sentence in another language beats none at all.',
    );
  });

  it('decides per headword, so one headword having none does not strip the other', () => {
    const rows = [
      exampleRow({ id: 'a', translationLanguageCode: 'en' }),
      exampleRow({
        id: 'b',
        headwordId: OTHER_UUID,
        translationLanguageCode: 'es',
        translationText: 'Ésta es su casa.',
      }),
    ];
    const byHeadword = collectExamples(rows, 5, 'en');
    assert.equal(
      byHeadword.get(SAMPLE_UUID)?.length,
      1,
      'the headword with an English sentence lost it, so the choice is being made across the ' +
        'whole result set rather than per headword.',
    );
    assert.equal(
      byHeadword.get(OTHER_UUID)?.length,
      1,
      'the headword with only a Spanish sentence was emptied because ANOTHER headword had an ' +
        'English one. The corpus covers words unevenly; each word gets the best it has.',
    );
  });

  it('applies the cap after the choice, not while filling the bucket', () => {
    // Two off-language rows sort ahead of the English one, and the cap is 2. A
    // cap applied while filling keeps the two Spanish rows and never reaches
    // the English row at all.
    const rows = [
      exampleRow({ id: 'a', translationLanguageCode: 'es', translationText: 'uno' }),
      exampleRow({ id: 'b', translationLanguageCode: 'es', translationText: 'dos' }),
      exampleRow({ id: 'c', translationLanguageCode: 'en' }),
    ];
    const kept = collectExamples(rows, 2, 'en').get(SAMPLE_UUID) ?? [];
    assert.deepEqual(
      kept.map((example) => example.id),
      ['c'],
      'the cap was spent before the preference was applied, so a preferred row that sorted ' +
        'late was dropped and off-language rows were served in its place.',
    );
  });
});

describe('sourceRecordUrl addresses the individual record', () => {
  it('links a Tatoeba sentence by the FIRST half of the paired external id', () => {
    assert.equal(
      sourceRecordUrl('tatoeba', '123:456'),
      'https://tatoeba.org/en/sentences/show/123',
      'the external id is written as <sentenceId>:<translationId>, and the page addressed is ' +
        'the sentence page. Linking the whole pair, or the second half, is a 404 on a public page.',
    );
  });

  it('links the CC0 half of the corpus the same way', () => {
    assert.equal(
      sourceRecordUrl('tatoeba-cc0', '123:456'),
      'https://tatoeba.org/en/sentences/show/123',
      'the licence split gives Tatoeba two source slugs, and both address the same sentence ' +
        'pages. Handling only one leaves half the corpus without a link.',
    );
  });

  it('returns null for a source we cannot address', () => {
    assert.equal(
      sourceRecordUrl('wikidata-lexemes', '123:456'),
      null,
      'a slug with no known URL pattern must produce no link. Guessing one publishes a broken ' +
        'link that looks authoritative.',
    );
  });

  it('returns null when there is no external id', () => {
    assert.equal(
      sourceRecordUrl('tatoeba', null),
      null,
      'our own generated rows carry a null external id. There is no upstream record to link to.',
    );
    assert.equal(sourceRecordUrl('tatoeba', ''), null, 'an empty id addresses nothing');
  });

  it('returns null for an id whose first segment is not a sentence id', () => {
    assert.equal(
      sourceRecordUrl('tatoeba', ':456'),
      null,
      'an empty first segment would build the bare base URL, which is not a sentence page.',
    );
    assert.equal(
      sourceRecordUrl('tatoeba', 'abc:1'),
      null,
      'a non-numeric first segment is not a Tatoeba sentence id. The shape is checked rather ' +
        'than assumed, because the result goes into an href on a public page.',
    );
  });
});

describe('licenceLabel covers every served licence', () => {
  it('gives a distinct, non-empty label to each member of SERVED_LICENCES', () => {
    // The tuple is iterated rather than re-listed here. A hand-copied list stops
    // covering the allowlist the moment a licence is added to it, which is the
    // one moment this case exists for.
    const labels = SERVED_LICENCES.map((licence) => licenceLabel(licence));
    for (const [index, label] of labels.entries()) {
      assert.notEqual(
        label,
        '',
        `${SERVED_LICENCES[index]} has an empty display label, so its credit renders as a ` +
          'bare comma with nothing after it.',
      );
    }
    assert.equal(
      new Set(labels).size,
      SERVED_LICENCES.length,
      `two served licences share a display label, so a reader cannot tell them apart: ` +
        JSON.stringify(labels),
    );
  });

  it('falls back to the raw identifier for a licence that is not served', () => {
    assert.equal(
      licenceLabel('CC-BY-SA-4.0'),
      'CC-BY-SA-4.0',
      'an unserved licence must never render as a blank or as a guessed label. A row of such ' +
        'a licence should not reach a page at all, so if one does, the page names it exactly.',
    );
  });
});
