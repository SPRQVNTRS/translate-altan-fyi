/**
 * The three pure decisions the Wikidata lexeme importer makes per line: what
 * counts as an entity, which language it is in, and what part of speech to
 * store.
 *
 * WHY THIS FILE MOCKS `#drizzle/tenant-db`
 *   `cli/commands/import/wikidata-lexemes.ts` imports `getRawDb` from
 *   `#drizzle/tenant-db`, which reaches `drizzle/db.ts`, which constructs a
 *   `pg.Pool` AND starts a retrying connect at module load. Importing the
 *   module in a unit test therefore opens a database connection and leaves a
 *   handle the runner never gets to close: the process hangs after the last
 *   assertion passes. Measured, not assumed.
 *
 *   So the specifier is stubbed before the module graph is loaded, with a
 *   `getRawDb` that throws. Nothing in this file goes near the database, and
 *   the throwing stub is what proves it rather than hoping it.
 *
 *   `mock.module` needs `--experimental-test-module-mocks`, which
 *   `pnpm test:unit` already passes.
 */
import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import type { DumpLine } from '../../cli/commands/import/wikidata-lexemes';

mock.module('#drizzle/tenant-db', {
  namedExports: {
    getRawDb: (): never => {
      throw new Error('a unit test must not reach the database');
    },
  },
});

const { parseDumpLine, lexemeLanguageCode, mapLexicalCategory } = await import(
  '../../cli/commands/import/wikidata-lexemes'
);

/** Resolved from this module's own location, so the working directory is irrelevant. */
const FIXTURE = resolve(import.meta.dirname, '../fixtures/importers/wikidata-lexemes.sample.json');

describe('parseDumpLine', () => {
  it('reports the array brackets and blank lines as not-an-entity', () => {
    // These are structure, not data. The caller counts a null as nothing at
    // all, which is what keeps `read` comparable with the dump's own entity
    // count instead of being two too high.
    assert.equal(parseDumpLine('['), null);
    assert.equal(parseDumpLine(']'), null);
    assert.equal(parseDumpLine(''), null);
    assert.equal(parseDumpLine('   \t '), null);
  });

  it('strips exactly one trailing comma and parses what is left', () => {
    const parsed = parseDumpLine('{"id":"L9","language":"Q1860"},');
    assert.deepEqual(parsed, { entity: { id: 'L9', language: 'Q1860' } });

    // The last entity of the array has no comma, and must parse the same way.
    assert.deepEqual(parseDumpLine('{"id":"L9","language":"Q1860"}'), {
      entity: { id: 'L9', language: 'Q1860' },
    });
  });

  it('throws on a line that looks like an entity and will not parse', () => {
    // The caller catches this and counts it under `parse` rather than ending a
    // run over 1.58 million lines. The count is a real signal: the file is
    // machine-written, so every line SHOULD parse, and a nonzero count means
    // the dump is truncated or corrupt or upstream changed the format. All
    // three deserve a look before the imported rows are trusted.
    assert.throws(() => parseDumpLine('{"id":"L9",'), SyntaxError);

    // Two trailing commas is one comma too many, and stripping both would hide
    // that. Only the last one is removed, so the rest is still malformed.
    assert.throws(() => parseDumpLine('{"id":"L9"},,'), SyntaxError);
  });
});

describe('lexemeLanguageCode', () => {
  it('maps the four language items the dictionary serves', () => {
    assert.equal(lexemeLanguageCode('Q1860'), 'en');
    assert.equal(lexemeLanguageCode('Q188'), 'de');
    assert.equal(lexemeLanguageCode('Q256'), 'tr');
    assert.equal(lexemeLanguageCode('Q1321'), 'es');
  });

  it('returns null for a language we do not serve', () => {
    // Q7026 is Aromanian and Q9035 is Danish. Both are real QIDs carried by
    // rows in the fixture, so this is the exact answer the importer gets when
    // it walks that file, not an invented one.
    assert.equal(lexemeLanguageCode('Q7026'), null);
    assert.equal(lexemeLanguageCode('Q9035'), null);
    assert.equal(lexemeLanguageCode(''), null);
    assert.equal(lexemeLanguageCode('constructor'), null);
  });
});

describe('mapLexicalCategory', () => {
  it('maps the five categories that are worth a bucket of their own', () => {
    assert.equal(mapLexicalCategory('Q1084'), 'noun');
    assert.equal(mapLexicalCategory('Q24905'), 'verb');
    assert.equal(mapLexicalCategory('Q34698'), 'adjective');
    assert.equal(mapLexicalCategory('Q380057'), 'adverb');
    assert.equal(mapLexicalCategory('Q147276'), 'noun');
  });

  it('folds proper noun into noun rather than opening a sixth bucket', () => {
    // The part of speech is part of the headword natural key, and no other
    // source can produce "proper noun". A bucket only Wikidata can reach would
    // split one word into two headwords that never meet.
    assert.equal(mapLexicalCategory('Q147276'), mapLexicalCategory('Q1084'));
  });

  it('answers other for an unknown category instead of failing', () => {
    // Q576271 is numeral, which the fixture carries. Pronouns, prepositions
    // and the whole long tail land here too, deliberately.
    assert.equal(mapLexicalCategory('Q576271'), 'other');
    assert.equal(mapLexicalCategory('Q0'), 'other');
    assert.equal(mapLexicalCategory(''), 'other');
  });
});

/**
 * What one pass over the fixture found, in the shape the importer would count it.
 */
interface FixtureTally {
  entities: number;
  structural: number;
  served: number;
  unserved: number;
  parseFailures: number;
}

/** The one field this walk needs from an entity. */
const LexemeLanguageSchema = z.object({ language: z.string() });

/**
 * Walk the fixture exactly as the importer walks the real dump: line by line,
 * through `parseDumpLine`, catching a throw and counting it.
 */
function tallyFixture(): FixtureTally {
  const tally: FixtureTally = {
    entities: 0,
    structural: 0,
    served: 0,
    unserved: 0,
    parseFailures: 0,
  };

  for (const line of readFileSync(FIXTURE, 'utf8').split('\n')) {
    let parsed: DumpLine | null = null;
    try {
      parsed = parseDumpLine(line);
    } catch {
      tally.parseFailures += 1;
      continue;
    }
    if (parsed === null) {
      tally.structural += 1;
      continue;
    }

    tally.entities += 1;
    const entity = LexemeLanguageSchema.parse(parsed.entity);
    if (lexemeLanguageCode(entity.language) === null) {
      tally.unserved += 1;
    } else {
      tally.served += 1;
    }
  }

  return tally;
}

describe('the real dump fixture', () => {
  it('parses every entity and files nine of twelve under a served language', () => {
    const tally = tallyFixture();

    // The file is machine-written, so a parse failure here would mean the
    // fixture itself is broken and every other number below is unreliable.
    assert.equal(tally.parseFailures, 0, 'the fixture should be well-formed JSON per line');
    assert.equal(tally.entities, 12);

    // The opening bracket, the closing bracket, and the trailing newline. None
    // of them is a row, and the importer counts none of them.
    assert.equal(tally.structural, 3);

    assert.equal(tally.served, 9, 'nine entities are in en, de, tr or es');
    assert.equal(tally.unserved, 3, 'three are not, and the language filter drops them');
    assert.equal(tally.served + tally.unserved, tally.entities);
  });
});
