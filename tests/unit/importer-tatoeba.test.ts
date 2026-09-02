/**
 * The Tatoeba importer's line reader and language filter, and the fixture fact
 * that its licence rule depends on.
 *
 * WHY THIS FILE MOCKS `#drizzle/tenant-db`
 *   `cli/commands/import/tatoeba.ts` imports `getRawDb`, which reaches
 *   `drizzle/db.ts`, which constructs a `pg.Pool` and starts a retrying connect
 *   at module load. Importing the module for real in a unit test opens a
 *   connection and hangs the runner after the last assertion passes. Measured,
 *   not assumed. The stub throws, so a stray database call fails loudly instead
 *   of quietly succeeding against a developer's local Postgres.
 */
import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

mock.module('#drizzle/tenant-db', {
  namedExports: {
    getRawDb: (): never => {
      throw new Error('a unit test must not reach the database');
    },
  },
});

const { tatoebaLanguageCode, parseSentenceLine } = await import(
  '../../cli/commands/import/tatoeba'
);

/** Resolved from this module's own location, so the working directory is irrelevant. */
const FIXTURES = resolve(import.meta.dirname, '../fixtures/importers');

/** Read a fixture as its non-empty lines. */
function fixtureLines(name: string): string[] {
  return readFileSync(resolve(FIXTURES, name), 'utf8')
    .split('\n')
    .filter((line) => line !== '');
}

/** The sentence ids of an export, in the order it lists them. */
function sentenceIds(name: string): string[] {
  return fixtureLines(name).map((line) => {
    const sentence = parseSentenceLine(line);
    assert.ok(sentence, `unparseable line in ${name}: ${line}`);
    return sentence.id;
  });
}

describe('tatoebaLanguageCode', () => {
  it('maps the four ISO 639-3 codes the dictionary serves', () => {
    assert.equal(tatoebaLanguageCode('eng'), 'en');
    assert.equal(tatoebaLanguageCode('deu'), 'de');
    assert.equal(tatoebaLanguageCode('tur'), 'tr');
    assert.equal(tatoebaLanguageCode('spa'), 'es');
  });

  it('refuses the three languages planted in the fixture', () => {
    // `tatoeba-sentences.tsv` carries one fra, one jpn and one ita row, and
    // `tatoeba-links.tsv` links two of them to each other and one of them to a
    // served English sentence. They exist so that a run over the fixture has
    // real rows it must drop. There is no `languages` row for any of the
    // three, so a row that got through would fail on a foreign key.
    assert.equal(tatoebaLanguageCode('fra'), null);
    assert.equal(tatoebaLanguageCode('jpn'), null);
    assert.equal(tatoebaLanguageCode('ita'), null);
  });

  it('returns null for an empty code and for a prototype key', () => {
    assert.equal(tatoebaLanguageCode(''), null);
    assert.equal(tatoebaLanguageCode('constructor'), null);
  });
});

describe('parseSentenceLine', () => {
  it('reads the six-column sentences_detailed form', () => {
    const line =
      '330998\teng\tChildren who spend more time outdoors have a lower risk of myopia.\tTRANG\t2009-01-18 22:30:40\t2019-01-12 19:39:42';

    assert.deepEqual(parseSentenceLine(line), {
      id: '330998',
      iso3: 'eng',
      text: 'Children who spend more time outdoors have a lower risk of myopia.',
    });
  });

  it('reads the four-column sentences_CC0 form the same way', () => {
    // One function reads both exports, because the first three columns are id,
    // lang and text in both, and those three are all this importer stores.
    const line =
      '330998\teng\tChildren who spend more time outdoors have a lower risk of myopia.\t2019-01-12 19:39:42';

    assert.deepEqual(parseSentenceLine(line), {
      id: '330998',
      iso3: 'eng',
      text: 'Children who spend more time outdoors have a lower risk of myopia.',
    });
  });

  it('reports a line with fewer than three fields as not a sentence', () => {
    // The caller counts a null under `malformed` rather than ending the run.
    assert.equal(parseSentenceLine('330998\teng'), null);
    assert.equal(parseSentenceLine('330998'), null);
    assert.equal(parseSentenceLine(''), null);
  });

  it('refuses a line whose id, language or text is blank', () => {
    // Three fields are present but one is empty, which is a shape a truncated
    // or re-exported dump really produces. An empty id would key a row that
    // every other broken row also keys.
    assert.equal(parseSentenceLine('\teng\tsome text'), null);
    assert.equal(parseSentenceLine('330998\t\tsome text'), null);
    assert.equal(parseSentenceLine('330998\teng\t'), null);
  });
});

describe('the CC0 export is a licence subset of the sentence export', () => {
  it('names only sentences the main export also carries', () => {
    // THE FACT THIS ENCODES.
    //
    // The Tatoeba dump has NO per-row licence column. The spec assumed one and
    // it does not exist, so the licence cannot be read off a sentence. It is
    // carried instead by WHICH source row an example is attached to: a
    // sentence named in the separate CC0 export was relicensed by its
    // contributor, and every other sentence is CC BY 2.0 FR.
    //
    // That only works while the CC0 export is a subset of the sentence export.
    // A CC0 id with no sentence behind it would be a licence claim about a row
    // the importer never sees.
    const sentences = new Set(sentenceIds('tatoeba-sentences.tsv'));
    const cc0 = new Set(sentenceIds('tatoeba-cc0.tsv'));

    assert.equal(sentences.size, 32);
    assert.equal(cc0.size, 14);

    const orphans = [...cc0].filter((id) => !sentences.has(id));
    assert.deepEqual(orphans, [], 'a CC0 id names a sentence the main export does not carry');

    // Strict, not merely contained: most sentences are NOT CC0, which is why
    // the CC BY source row exists and is the default.
    assert.ok(cc0.size < sentences.size, 'the CC0 export should be the smaller set');
  });

  it('carries at least one link whose two sentences are both CC0', () => {
    // A PAIR IS CC0 ONLY WHEN BOTH OF ITS SENTENCES ARE.
    //
    // An example row holds two texts: its own and its translation. Choosing the
    // source from one side alone would file a CC BY translation under a CC0
    // source, and every reader would then be told they may reuse that
    // translation without attribution. So the importer takes the CC0 source
    // only when both ids appear in the CC0 export.
    //
    // The fixture has to contain such a pair or the CC0 branch of that rule is
    // never exercised by any run over it, and a test of the rule would pass
    // while proving nothing.
    const cc0 = new Set(sentenceIds('tatoeba-cc0.tsv'));

    const fullyCc0: string[] = [];
    for (const line of fixtureLines('tatoeba-links.tsv')) {
      const [left, right] = line.split('\t');
      if (left === undefined || right === undefined) continue;
      if (cc0.has(left) && cc0.has(right)) fullyCc0.push(`${left}:${right}`);
    }

    assert.deepEqual(
      fullyCc0.toSorted(),
      ['7843793:7844067', '7844067:7843793'],
      'the fixture should link the CC0 English sentence 7843793 to the CC0 German 7844067, in both directions',
    );
  });

  it('publishes identical text in both exports for that pair', () => {
    // The importer takes the CC0 source only when the stored text still
    // matches what the CC0 export published, because the two exports are
    // separate snapshots and a sentence can have been edited between them. So
    // a fixture pair that is CC0 by id alone is not enough: the texts have to
    // agree too, or the run files the pair under CC BY and the CC0 branch is
    // still never taken.
    const textById = (name: string): Map<string, string> => {
      const texts = new Map<string, string>();
      for (const line of fixtureLines(name)) {
        const sentence = parseSentenceLine(line);
        if (sentence === null) continue;
        texts.set(sentence.id, sentence.text);
      }
      return texts;
    };

    const main = textById('tatoeba-sentences.tsv');
    const cc0 = textById('tatoeba-cc0.tsv');

    for (const id of ['7843793', '7844067']) {
      assert.equal(cc0.get(id), main.get(id), `the two exports disagree about sentence ${id}`);
    }
  });
});
