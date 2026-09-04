/**
 * The pure decisions the Wikidata lexeme importer makes per line: what counts
 * as an entity, which language it is in, what part of speech to store, what
 * the schema keeps of a sense, and which `P5972` statements become translation
 * edges.
 *
 * WHY THIS FILE MOCKS `#drizzle/db`
 *   `cli/commands/import/wikidata-lexemes.ts` imports `getRawDb` from
 *   `#drizzle/db`, which reaches `drizzle/db.ts`, which constructs a
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
import type { DumpLine, Lexeme } from '../../cli/commands/import/wikidata-lexemes';

mock.module('#drizzle/db', {
  namedExports: {
    getRawDb: (): never => {
      throw new Error('a unit test must not reach the database');
    },
  },
});

const {
  parseDumpLine,
  lexemeLanguageCode,
  mapLexicalCategory,
  LexemeSchema,
  collectSenseTranslations,
} = await import('../../cli/commands/import/wikidata-lexemes');

/** Resolved from this module's own location, so the working directory is irrelevant. */
const FIXTURE = resolve(import.meta.dirname, '../fixtures/importers/wikidata-lexemes.sample.json');

/**
 * Every entity of the fixture, parsed through the importer's own schema and
 * keyed by lexeme id.
 *
 * Going through `LexemeSchema` rather than `JSON.parse` alone is the point: the
 * tests below then work on the same value the importer works on, including the
 * fields zod has already stripped.
 */
function loadFixtureLexemes(): Map<string, Lexeme> {
  const byId = new Map<string, Lexeme>();
  for (const line of readFileSync(FIXTURE, 'utf8').split('\n')) {
    const parsed = parseDumpLine(line);
    if (parsed === null) continue;
    const lexeme = LexemeSchema.parse(parsed.entity);
    byId.set(lexeme.id, lexeme);
  }
  return byId;
}

const FIXTURE_LEXEMES = loadFixtureLexemes();

/** One fixture lexeme, or a throw naming the missing id rather than a confusing undefined. */
function fixtureLexeme(id: string): Lexeme {
  const lexeme = FIXTURE_LEXEMES.get(id);
  if (lexeme === undefined) throw new Error(`the fixture carries no lexeme ${id}`);
  return lexeme;
}

/**
 * The one hand-assembled entity in an otherwise verbatim fixture.
 *
 * Every other line is a real dump row. `L4` carries statements written by hand,
 * in the exact shape the dump uses, because the four cases they cover, a live
 * edge, a synonym, a deprecated rank and a value-less snak, do not co-occur on
 * any single real lexeme. Its `P5972` target `L8412-S1` is a sense of the real
 * Turkish row further down the file, so the pair is resolvable in a later
 * integration run rather than pointing at nothing.
 */
const TRANSLATION_LEXEME_ID = 'L4';

/** Enough of a fixture line to find the entity these tests are about. */
const EntityIdSchema = z.object({ id: z.string() });

/**
 * The statements as the fixture LINE carries them, including `P5973`, which
 * `LexemeSchema` strips.
 *
 * This exists so the skip assertions are not vacuous. "No edge to `L9-S1`" and
 * "no `P5973` key" both pass on a fixture that never carried a synonym at all,
 * so the fixture is read a second time, unstripped, to prove each case is
 * actually present before asserting it was dropped.
 */
const RawClaimsSchema = z.object({
  senses: z.array(
    z.object({
      id: z.string(),
      claims: z.object({
        P5972: z.array(
          z.object({
            rank: z.string(),
            mainsnak: z.object({
              snaktype: z.string(),
              datavalue: z.object({ value: z.object({ id: z.string() }) }).optional(),
            }),
          }),
        ),
        P5973: z.array(
          z.object({ mainsnak: z.object({ datavalue: z.object({ value: z.object({ id: z.string() }) }) }) }),
        ),
      }),
    }),
  ),
});

/** The unstripped statements of the one fixture entity that carries any. */
function loadRawClaims(): z.infer<typeof RawClaimsSchema> {
  for (const line of readFileSync(FIXTURE, 'utf8').split('\n')) {
    const parsed = parseDumpLine(line);
    if (parsed === null) continue;
    if (EntityIdSchema.parse(parsed.entity).id !== TRANSLATION_LEXEME_ID) continue;
    return RawClaimsSchema.parse(parsed.entity);
  }
  throw new Error(`the fixture carries no lexeme ${TRANSLATION_LEXEME_ID}`);
}

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

describe('LexemeSchema', () => {
  it('keeps one sense with many glosses as ONE sense', () => {
    // The model this importer writes: a Wikidata sense is one meaning, so its
    // six glosses are six wordings of that meaning and not six meanings. The
    // schema must hand the importer one sense carrying six glosses, so that one
    // `senses` row and six `sense_versions` rows come out of it.
    const lexeme = fixtureLexeme('L9');
    const [first] = lexeme.senses ?? [];

    assert.equal(lexeme.senses?.length, 4);
    assert.equal(first?.id, 'L9-S1');
    assert.equal(Object.keys(first?.glosses ?? {}).length, 6);

    // The id goes to `senses.external_id` verbatim. A `#de` suffix here would be
    // the rejected shape, where one meaning became one identity per gloss
    // language and a `P5972` edge had six possible landing places.
    assert.ok(!(first?.id ?? '').includes('#'));
  });

  it('reads P5972 and does not even carry P5973 through', () => {
    // `P5973` is "synonym", a same-language relation. It is not read, not just
    // not written: the schema names only `P5972` under `claims`, so zod strips
    // the synonym statement and no later step can accidentally import it.
    const sense = fixtureLexeme(TRANSLATION_LEXEME_ID).senses?.[0];

    assert.deepEqual(Object.keys(sense?.claims ?? {}), ['P5972']);
    assert.equal(sense?.claims?.P5972?.length, 4);
  });
});

describe('collectSenseTranslations', () => {
  it('has a fixture that really carries all four cases', () => {
    // Read before the skip assertions below, because each of them would pass on
    // a fixture that never carried the case it claims to drop.
    const [sense] = loadRawClaims().senses;
    const statements = sense?.claims.P5972 ?? [];

    assert.equal(sense?.id, 'L4-S1');
    assert.equal(statements.length, 4);
    assert.equal(statements.filter((s) => s.rank === 'deprecated').length, 1);
    assert.equal(statements.filter((s) => s.mainsnak.snaktype === 'somevalue').length, 1);
    assert.equal(
      statements.filter((s) => s.mainsnak.datavalue?.value.id === 'L4-S1').length,
      1,
      'one statement points at the sense it hangs from',
    );
    assert.deepEqual(
      sense?.claims.P5973.map((s) => s.mainsnak.datavalue.value.id),
      ['L9-S1'],
      'the synonym statement is in the file, so the strip is a real drop',
    );
  });

  it('returns the P5972 edge in the direction the statement points', () => {
    // One pair, in Wikidata ids, because no sense row exists yet. The importer
    // writes it in BOTH directions later; this function reports what upstream
    // said, once.
    const pairs = collectSenseTranslations(fixtureLexeme(TRANSLATION_LEXEME_ID));

    assert.deepEqual(pairs, [{ fromExternalId: 'L4-S1', toExternalId: 'L8412-S1' }]);
  });

  it('ignores the P5973 synonym statement', () => {
    // `L4-S1` carries a `P5973` pointing at `L9-S1`. An edge to it would put an
    // (English sense, English sense) pair on a cross-language surface, where a
    // reader asking for the German of a word is handed another English word.
    const pairs = collectSenseTranslations(fixtureLexeme(TRANSLATION_LEXEME_ID));

    assert.ok(pairs.every((pair) => pair.toExternalId !== 'L9-S1'));
  });

  it('skips a deprecated-rank statement', () => {
    // Deprecated means upstream recorded the statement as wrong and kept it for
    // history. `L4-S1` carries one pointing at `L87-S1`.
    const pairs = collectSenseTranslations(fixtureLexeme(TRANSLATION_LEXEME_ID));

    assert.ok(pairs.every((pair) => pair.toExternalId !== 'L87-S1'));
  });

  it('skips a snak that carries no value', () => {
    // A `somevalue` snak says a translation exists but is unknown, so there is
    // no id to point at. It must be skipped rather than counted as a parse
    // failure: the statement is well-formed, it just is not an edge. The
    // assertion is the pair COUNT, since a skipped snak has no id to look for.
    const pairs = collectSenseTranslations(fixtureLexeme(TRANSLATION_LEXEME_ID));

    assert.equal(pairs.length, 1);
  });

  it('skips a statement pointing at the sense it hangs from', () => {
    // `translations` carries a CHECK rejecting a row whose two endpoints are the
    // same sense, and the rows are written in batches, so one self-edge would
    // fail a whole batch. `L4-S1` carries one pointing at itself.
    const pairs = collectSenseTranslations(fixtureLexeme(TRANSLATION_LEXEME_ID));

    assert.ok(pairs.every((pair) => pair.fromExternalId !== pair.toExternalId));
  });

  it('returns nothing for a lexeme with no statements at all', () => {
    // Which is almost every lexeme in the dump. `senses` and `claims` are both
    // optional, and neither absence is an error.
    assert.deepEqual(collectSenseTranslations(fixtureLexeme('L9')), []);
    assert.deepEqual(collectSenseTranslations(fixtureLexeme('L312')), []);
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
  it('parses every entity and files ten of thirteen under a served language', () => {
    const tally = tallyFixture();

    // The file is machine-written, so a parse failure here would mean the
    // fixture itself is broken and every other number below is unreliable.
    assert.equal(tally.parseFailures, 0, 'the fixture should be well-formed JSON per line');
    assert.equal(tally.entities, 13);

    // The opening bracket, the closing bracket, and the trailing newline. None
    // of them is a row, and the importer counts none of them.
    assert.equal(tally.structural, 3);

    assert.equal(tally.served, 10, 'ten entities are in en, de, tr or es');
    assert.equal(tally.unserved, 3, 'three are not, and the language filter drops them');
    assert.equal(tally.served + tally.unserved, tally.entities);
  });
});
