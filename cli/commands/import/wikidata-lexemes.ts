/**
 * Import lexemes, senses and glosses from a Wikidata lexicographical dump.
 *
 * WHAT THE DUMP IS
 *   `latest-lexemes.json.bz2` is a JSON ARRAY printed one entity per line. The
 *   first line is `[`, the last line is `]`, and every line between them is one
 *   lexeme object followed by a comma, except the last one. The file is about
 *   1.58 million entities, so it is never held in memory and never handed to a
 *   single `JSON.parse`. It is read line by line and each line is parsed on its
 *   own.
 *
 * WHAT WE TAKE FROM IT
 *   The lemma, its language, its part of speech, the glosses of its senses, and
 *   exactly ONE statement property, `P5972` (translation). Nothing else.
 *   `forms` and the other hundreds of claim properties are the bulk of the
 *   bytes and none of them are in the schema, so they are not even described to
 *   the validator: an unmentioned field costs nothing, a described one costs a
 *   check on every entity of a 1.58 million line file.
 *
 * WHY THE LICENCE IS SAFE
 *   Wikidata lexicographical data is CC0, which is the only reason a gloss from
 *   it can be served with no attribution obligation attached to the reader. The
 *   licence is written on the source row and printed on every run, so a later
 *   audit can see under what terms these rows arrived.
 */

import { statSync } from 'node:fs';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { senses, senseVersions, translations } from '#drizzle/schema';
import type {
  InsertHeadword,
  InsertSense,
  InsertSenseVersion,
  InsertTranslation,
} from '#drizzle/schema';
import { getRawDb } from '#drizzle/tenant-db';
import { createDropCounter } from '../../lib/importers/contract';
import type {
  DropCounter,
  Importer,
  ImporterSource,
  ImportOptions,
  ImportSummary,
} from '../../lib/importers/contract';
import { normalizeLemma } from '../../lib/importers/normalize';
import { readLines } from '../../lib/importers/stream';
import { chunk, INSERT_CHUNK_SIZE, upsertHeadwords, upsertSource } from '../../lib/importers/upsert';
import type { ImporterDb } from '../../lib/importers/upsert';

// =============================================================================
// The source row
// =============================================================================

/**
 * The version is filled in at run time, from the dump file's own mtime.
 *
 * The file upstream publishes is called `latest-lexemes.json.bz2` and it says
 * nothing inside about which day's data it holds. The only date available to us
 * is when the operator's copy was written, so that is what goes in the version
 * column, formatted `YYYY-MM-DD`. It is an approximation of the dump date and
 * should be read as one: it is the day the file landed on this disk.
 *
 * WHY THIS OBJECT IS MUTATED AND NOT REBUILT
 *   `printSummary` is called by the CLI with `wikidataLexemesImporter.source`,
 *   AFTER `run()` has returned. It reads whatever that object holds at that
 *   moment. A resolved copy returned from `run()` would therefore never reach
 *   the printed summary, and the operator would read `unknown` under Version on
 *   a run that knew the answer. So `run()` writes the resolved version back
 *   onto this one object, which is the object the printer already has.
 */
const source: ImporterSource = {
  slug: 'wikidata-lexemes',
  name: 'Wikidata lexicographical data',
  url: 'https://dumps.wikimedia.org/wikidatawiki/entities/latest-lexemes.json.bz2',
  licence: 'CC0-1.0',
  attribution: 'Wikidata lexicographical data, CC0',
  version: 'unknown',
};

/** `YYYY-MM-DD` from the dump file's modification time, in UTC. */
function dumpVersion(file: string): string {
  // statSync throws when the file is missing, which is the right moment to
  // fail: an import that cannot see its dump has nothing to do.
  return statSync(file).mtime.toISOString().slice(0, 10);
}

// =============================================================================
// Line parsing
// =============================================================================

/**
 * One parsed line of the dump.
 *
 * The wrapper exists because `entity` is raw JSON that nothing has checked yet,
 * and a function here may not hand `unknown` back to its caller. The value gets
 * a real type one step later, when the Zod schema parses it. Until then it
 * travels inside this box, which says out loud that it is unvalidated.
 */
export interface DumpLine {
  entity: unknown;
}

/**
 * Parse one line of the dump.
 *
 * Returns null for a structural line: the opening `[`, the closing `]`, or a
 * blank line. Those are not entities and must never be counted as rows read.
 *
 * Throws when the line looks like an entity and will not parse. The caller
 * catches that and counts it, because one bad line must not end a run over 1.58
 * million of them. But a `parse` count in the summary is a real signal and not
 * noise: this file is machine-written, so every line SHOULD parse. A nonzero
 * count means the dump is truncated, corrupt, or that upstream changed the
 * format, and all three deserve a look before the imported rows are trusted.
 */
export function parseDumpLine(line: string): DumpLine | null {
  const trimmed = line.trim();
  if (trimmed === '' || trimmed === '[' || trimmed === ']') return null;

  // Exactly one trailing comma, because that is what the array printer emits
  // between entities. Stripping more than one would hide a malformed line.
  const text = trimmed.endsWith(',') ? trimmed.slice(0, -1) : trimmed;
  return { entity: JSON.parse(text) };
}

/**
 * One `P5972` statement, which is Wikidata's "translation" property on a sense.
 *
 * The value is another SENSE id, not a lexeme id and not a string of text:
 * `{"entity-type":"sense","id":"L144039-S1"}`. That is what makes this property
 * usable at all, because our `translations` table is an edge between two
 * meanings and a word-level property could not fill it.
 *
 * `datavalue` is OPTIONAL because a `novalue` or `somevalue` snak carries none.
 * Such a statement says "there is deliberately no translation here", which is
 * information about the absence and not an edge, so `collectSenseTranslations`
 * skips it rather than treating a missing field as a parse failure.
 */
const TranslationStatementSchema = z.object({
  rank: z.string(),
  mainsnak: z.object({
    snaktype: z.string(),
    datavalue: z.object({ value: z.object({ id: z.string() }) }).optional(),
  }),
});

/**
 * The shape we need from a lexeme, and nothing more.
 *
 * Validation happens here, at the I/O boundary, once per entity. Everything
 * downstream works on the parsed value and never re-checks a field.
 *
 * WHY `claims` IS A `z.object` AND NOT A RECORD
 *   A sense carries statements under `claims`, keyed by property id, and there
 *   are hundreds of properties in use across the dump. Describing `claims` as
 *   an open record would validate EVERY property of EVERY sense, which is a
 *   check per property per entity over 1.58 million entities, to then throw all
 *   of them away but one. A `z.object` naming only `P5972` costs one lookup and
 *   zod strips the rest unread, which is exactly the "an unmentioned field
 *   costs nothing" rule the rest of this schema already follows.
 *
 * WHY `P5973` IS NOT HERE
 *   `P5973` is "synonym". A synonym is a SAME-LANGUAGE relation between two
 *   senses, and `translations` is the cross-language result surface we serve.
 *   Importing it would put pairs like (English sense, English sense) into that
 *   surface, where a reader asking for the German of a word would be handed
 *   another English word. It is not read, not just not written.
 *
 * Exported so a test can feed it a line of the real dump and work on the same
 * value the importer works on, rather than on a hand-built stand-in.
 */
export const LexemeSchema = z.object({
  id: z.string(),
  language: z.string(),
  lexicalCategory: z.string(),
  lemmas: z.record(z.string(), z.object({ language: z.string(), value: z.string() })),
  senses: z
    .array(
      z.object({
        id: z.string(),
        glosses: z
          .record(z.string(), z.object({ language: z.string(), value: z.string() }))
          .optional(),
        claims: z.object({ P5972: z.array(TranslationStatementSchema).optional() }).optional(),
      }),
    )
    .optional(),
});

export type Lexeme = z.infer<typeof LexemeSchema>;

// =============================================================================
// Mapping
// =============================================================================

/** The closed set of parts of speech this importer writes. */
export type POS = 'noun' | 'verb' | 'adjective' | 'adverb' | 'other';

/**
 * Wikidata lexical category QIDs we recognise.
 *
 * WHY THE SET IS THIS SMALL, ON PURPOSE
 *   The part of speech is part of the headword natural key,
 *   `(language, lemma, pos)`. Whatever goes in that column decides whether two
 *   sources are talking about the same headword. Wikidata has hundreds of
 *   lexical category items, and writing the raw QID would fragment the key into
 *   hundreds of buckets that no other source uses: PanLex and Tatoeba would
 *   never land on `Q1084`, so `noun` from them and `Q1084` from here would be
 *   two different headwords for one word, forever.
 *
 *   Five values keep the key small enough that every source can hit it.
 *
 * WHY PROPER NOUN IS FOLDED INTO NOUN
 *   `Q147276` is proper noun. It maps to `noun`, which loses the distinction
 *   between "berlin" and "berlin the common noun". We do not use that
 *   distinction anywhere today, and keeping it would put a sixth bucket in the
 *   natural key that no other importer can produce. If a later milestone needs
 *   proper nouns, it comes back here.
 */
const CATEGORY_BY_QID = new Map<string, POS>([
  ['Q1084', 'noun'],
  ['Q147276', 'noun'],
  ['Q24905', 'verb'],
  ['Q34698', 'adjective'],
  ['Q380057', 'adverb'],
]);

/**
 * Part of speech for a lexical category QID.
 *
 * Everything unlisted, which includes pronouns, prepositions, conjunctions,
 * determiners, affixes and the whole long tail, becomes `other`. That is a
 * deliberate loss and not a gap to be filled in later: see the note above.
 */
export function mapLexicalCategory(qid: string): POS {
  return CATEGORY_BY_QID.get(qid) ?? 'other';
}

/** Wikidata language items for the four languages the dictionary serves. */
const LANGUAGE_BY_QID = new Map<string, string>([
  ['Q1860', 'en'],
  ['Q188', 'de'],
  ['Q256', 'tr'],
  ['Q1321', 'es'],
]);

/** Our language code for a lexeme's language QID, or null when we do not serve it. */
export function lexemeLanguageCode(qid: string): string | null {
  return LANGUAGE_BY_QID.get(qid) ?? null;
}

/**
 * The lemma to store for a lexeme.
 *
 * A lexeme can carry several written forms, one per script or spelling variant.
 * The one that matches the lexeme's own language is the one we want. When there
 * is no such entry we take the first form the dump listed, because insertion
 * order in the dump is the order upstream considers primary. Null when the
 * lexeme has no written form at all, which the schema allows and reality
 * occasionally produces.
 */
function pickLemma(lexeme: Lexeme, languageCode: string): string | null {
  const preferred = lexeme.lemmas[languageCode]?.value;
  if (preferred !== undefined && preferred.trim() !== '') return preferred;

  for (const entry of Object.values(lexeme.lemmas)) {
    if (entry.value.trim() !== '') return entry.value;
  }
  return null;
}

// =============================================================================
// Staging: one sense row, one sense version per gloss language
// =============================================================================
//
// THE DECISION, AND THE ALTERNATIVE THAT WAS REJECTED
//   One Wikidata sense usually carries glosses in several languages at once.
//   `L9-S1` alone has English, German, French, Spanish, Thai and Italian. The
//   question is what that becomes in our schema.
//
//   A Wikidata sense is ONE meaning. The six glosses are six wordings of that
//   same meaning, not six meanings. So it becomes ONE `senses` row, carrying
//   `external_id` = `L9-S1` with no suffix of any kind, and one
//   `sense_versions` row per gloss language, all of them at version 1. The
//   languages we do not serve are dropped; the rest hang off the one sense.
//
//   The rejected alternative is the shape this importer used to write: one
//   `senses` row per (Wikidata sense, gloss language) pair, with
//   `external_id` = `L9-S1#de`. It was chosen because `sense_versions` was then
//   unique on `(sense_id, version)`, so two glosses could not both sit at
//   version 1, and numbering them 1 and 2 would have been a lie about what
//   `version` means. That reasoning was sound about `version` and wrong about
//   the model: it split one meaning into six identities, so the six glosses of
//   `L9-S1` were six unrelated senses that could never be recognised as the
//   same thing, and a `P5972` translation edge pointing at `L9-S1` had six
//   possible landing places and no way to choose. Overruled by operator
//   decision; the constraint moved to `(sense_id, gloss_language_code, version)`
//   instead, which holds the glosses apart without inventing identities.
//
//   `senses.external_id` therefore carries the upstream id and nothing else,
//   which is also what makes it joinable against a `P5972` statement value.
//   The unique constraint on `(source_id, external_id)` is what makes a second
//   run of this importer write nothing new.

/** A gloss staged for writing, before it has a headword id or a sense id. */
interface StagedGloss {
  /** Natural key of the headword this gloss hangs from, in the form `upsertHeadwords` returns. */
  headwordKey: string;
  /** The Wikidata sense id, e.g. `L9-S1`, written verbatim to `senses.external_id`. */
  externalId: string;
  glossLanguageCode: string;
  gloss: string;
}

interface CollectGlossesInput {
  lexeme: Lexeme;
  headwordKey: string;
  languages: ReadonlySet<string>;
  counter: DropCounter;
}

function collectGlosses(input: CollectGlossesInput): StagedGloss[] {
  const staged: StagedGloss[] = [];

  for (const sense of input.lexeme.senses ?? []) {
    for (const [glossLanguage, gloss] of Object.entries(sense.glosses ?? {})) {
      if (!input.languages.has(glossLanguage)) {
        input.counter.drop('gloss-language');
        continue;
      }
      staged.push({
        headwordKey: input.headwordKey,
        externalId: sense.id,
        glossLanguageCode: glossLanguage,
        gloss: gloss.value,
      });
    }
  }

  return staged;
}

// =============================================================================
// Staging: P5972 translation edges
// =============================================================================

/** One upstream translation edge, still in Wikidata ids because no sense row exists yet. */
export interface TranslationPair {
  fromExternalId: string;
  toExternalId: string;
}

/** The rank Wikidata gives a statement that is recorded as known to be wrong. */
const DEPRECATED_RANK = 'deprecated';

/** The snak type that carries an actual value. `novalue` and `somevalue` carry none. */
const VALUE_SNAK = 'value';

/**
 * The `P5972` edges of one lexeme, in Wikidata ids.
 *
 * Pure on purpose: it reads a parsed lexeme and returns pairs, so the decision
 * of what counts as an edge is testable without a dump and without a database.
 * Resolving those ids to sense ids is a separate step that needs both.
 *
 * WHAT IS SKIPPED, AND WHY
 *   A `deprecated` rank means upstream recorded the statement as wrong and kept
 *   it for history. Importing it would serve a translation Wikidata itself
 *   disowns.
 *
 *   A snak type other than `value` is `novalue` or `somevalue`: the statement
 *   asserts that there is no translation, or that there is one but it is
 *   unknown. Neither is an edge.
 *
 *   A statement pointing at the sense it hangs from is skipped here rather than
 *   later, because `translations` carries a CHECK that rejects a row whose two
 *   endpoints are the same sense, and a whole batch would fail on one such row.
 */
export function collectSenseTranslations(lexeme: Lexeme): TranslationPair[] {
  const pairs: TranslationPair[] = [];

  for (const sense of lexeme.senses ?? []) {
    for (const statement of sense.claims?.P5972 ?? []) {
      if (statement.rank === DEPRECATED_RANK) continue;
      if (statement.mainsnak.snaktype !== VALUE_SNAK) continue;
      const target = statement.mainsnak.datavalue?.value.id;
      if (target === undefined || target === sense.id) continue;
      pairs.push({ fromExternalId: sense.id, toExternalId: target });
    }
  }

  return pairs;
}

// =============================================================================
// Writing
// =============================================================================

/** The version every gloss from this importer is written at. Re-enrichment starts above it. */
const FIRST_VERSION = 1;

/**
 * The source id used while dry running.
 *
 * A dry run writes nothing, including no source row, so there is no real id to
 * put on the staged rows. The rows are still built, because building them is
 * what a dry run is measuring, and they need SOMETHING in a NOT NULL column.
 * This value never reaches the database.
 */
const DRY_RUN_SOURCE_ID = '00000000-0000-0000-0000-000000000000';

/** How often the progress line is written, in entities read. */
const PROGRESS_INTERVAL = 100_000;

interface WriteCounts {
  headwords: number;
  senses: number;
  senseVersions: number;
  translations: number;
}

/** Rows waiting to be written. Filled while reading, emptied by `flushBatch`. */
interface Batch {
  headwords: InsertHeadword[];
  glosses: StagedGloss[];
}

function emptyBatch(): Batch {
  return { headwords: [], glosses: [] };
}

/** The natural key of a headword, in exactly the form `upsertHeadwords` keys its result map by. */
function headwordKeyOf(row: InsertHeadword): string {
  return `${row.languageCode}\t${row.lemma}\t${row.pos ?? ''}`;
}

function addCounts(total: WriteCounts, batch: WriteCounts): void {
  total.headwords += batch.headwords;
  total.senses += batch.senses;
  total.senseVersions += batch.senseVersions;
  total.translations += batch.translations;
}

interface FlushInput {
  db: ImporterDb;
  sourceId: string;
  batch: Batch;
  dryRun: boolean;
}

/**
 * Write one batch and report what landed.
 *
 * Rows are accumulated and written in batches, never one at a time. A dump of
 * this size at one statement per row is a round trip per word, which turns a
 * run of minutes into a run of hours for no gain.
 *
 * WHY THE SENSE INSERT IS `DO UPDATE` AND NOT `DO NOTHING`
 *   The same trap `upsertHeadwords` documents. `DO NOTHING` returns no row for
 *   a conflicting insert, so on the second run every sense id would come back
 *   empty and every `sense_versions` row would have nothing to hang from.
 *   `DO UPDATE` touches the row, which makes it a returned row, so first-run
 *   and second-run ids both come back. The update itself writes the headword id
 *   from the excluded row, which is a no-op whenever nothing moved.
 *
 * WHY THE BATCH IS DE-DUPLICATED TWICE, ON TWO DIFFERENT KEYS
 *   Postgres raises "ON CONFLICT DO UPDATE command cannot affect row a second
 *   time" when one statement carries the same conflict key twice, and the two
 *   statements below have DIFFERENT conflict keys, so one de-duplication cannot
 *   serve both.
 *
 *   The gloss map is keyed by (external id, gloss language), which is the grain
 *   of a `sense_versions` row. Keying it by external id alone would silently
 *   collapse the five languages of one sense into whichever one was staged last
 *   and write a single version row instead of five.
 *
 *   The sense map is keyed by external id alone, which is the grain of a
 *   `senses` row, because those five glosses are five wordings of ONE meaning
 *   and must produce one sense. The dump can also present the same sense id in
 *   more than one entity inside a batch, which this same map absorbs.
 */
async function flushBatch(input: FlushInput): Promise<WriteCounts> {
  const counts: WriteCounts = { headwords: 0, senses: 0, senseVersions: 0, translations: 0 };
  if (input.batch.headwords.length === 0) return counts;

  const uniqueGlosses = new Map<string, StagedGloss>();
  for (const staged of input.batch.glosses) {
    uniqueGlosses.set(`${staged.externalId}\t${staged.glossLanguageCode}`, staged);
  }

  const uniqueSenses = new Map<string, StagedGloss>();
  for (const staged of uniqueGlosses.values()) {
    uniqueSenses.set(staged.externalId, staged);
  }

  // A dry run counts what it WOULD offer the database. It cannot know how many
  // rows a real run would find already there, so these numbers are an upper
  // bound on a first import and an over-count on a re-import. That is the point
  // of the mode: it is how an operator sizes a dump before committing to it.
  if (input.dryRun) {
    const uniqueHeadwords = new Set<string>();
    for (const row of input.batch.headwords) {
      uniqueHeadwords.add(headwordKeyOf(row));
    }
    counts.headwords = uniqueHeadwords.size;
    counts.senses = uniqueSenses.size;
    counts.senseVersions = uniqueGlosses.size;
    return counts;
  }

  const headwordIds = await upsertHeadwords(input.db, input.batch.headwords);
  counts.headwords = headwordIds.size;

  const senseRows: InsertSense[] = [];
  for (const staged of uniqueSenses.values()) {
    const headwordId = headwordIds.get(staged.headwordKey);
    if (headwordId === undefined) {
      throw new Error(
        `No headword id for "${staged.headwordKey}" while writing sense ${staged.externalId}`,
      );
    }
    senseRows.push({ headwordId, sourceId: input.sourceId, externalId: staged.externalId });
  }

  const senseIds = new Map<string, string>();
  for (const part of chunk(senseRows, INSERT_CHUNK_SIZE)) {
    const written = await input.db
      .insert(senses)
      .values(part)
      .onConflictDoUpdate({
        target: [senses.sourceId, senses.externalId],
        set: { headwordId: sql`excluded.headword_id` },
      })
      .returning({ id: senses.id, externalId: senses.externalId });

    for (const row of written) {
      // `external_id` is nullable in the schema, for senses we mint ourselves.
      // Every row this importer writes carries one, so a null here would mean
      // the database handed back a row we did not send.
      if (row.externalId === null) continue;
      senseIds.set(row.externalId, row.id);
    }
  }
  counts.senses = senseIds.size;

  const versionRows: InsertSenseVersion[] = [];
  for (const staged of uniqueGlosses.values()) {
    const senseId = senseIds.get(staged.externalId);
    if (senseId === undefined) {
      throw new Error(`No sense id for external id "${staged.externalId}" after insert`);
    }
    versionRows.push({
      senseId,
      version: FIRST_VERSION,
      glossLanguageCode: staged.glossLanguageCode,
      gloss: staged.gloss,
      sourceId: input.sourceId,
    });
  }

  for (const part of chunk(versionRows, INSERT_CHUNK_SIZE)) {
    // `DO NOTHING` is right here, unlike above: nothing downstream needs these
    // ids, so losing them on a re-run costs nothing. What comes back from
    // RETURNING is exactly the rows that really landed, which is what we count.
    const written = await input.db
      .insert(senseVersions)
      .values(part)
      .onConflictDoNothing({
        target: [senseVersions.senseId, senseVersions.glossLanguageCode, senseVersions.version],
      })
      .returning({ id: senseVersions.id });
    counts.senseVersions += written.length;
  }

  return counts;
}

// =============================================================================
// Resolving the P5972 edges
// =============================================================================
//
// WHY THIS RUNS AFTER THE READ LOOP AND NOT INSIDE IT
//   A `P5972` statement names a sense that may live anywhere in the dump,
//   including thousands of lines further down, so at the moment the statement
//   is read the target sense usually has no row yet. Resolving it inline would
//   mean either a lookup that finds nothing most of the time, or holding the
//   whole dump in memory. Both endpoints exist once the last batch is flushed,
//   so resolution happens exactly once, at the end.
//
// WHAT THAT COSTS IN MEMORY
//   Only the pairs are held, and only for lexemes this importer KEEPS. Measured
//   on the real dump: 136,087 `P5972` statements exist in total, 9,484 of them
//   hang off senses in our four languages, and 1,848 of those point at a target
//   that is also in our four languages. So the bound is a few thousand short
//   strings, not millions, and it does not grow with the size of the dump.
//
//   The gap between 9,484 and 1,848 is not waste to be optimised away: whether
//   a target is in a served language cannot be known while reading, because the
//   statement carries a sense id and not a language. Those pairs are carried,
//   fail to resolve, and are counted under `translation-target-missing`.

/** Both directions of an edge are written, so one pair offers two rows. */
const DIRECTIONS_PER_PAIR = 2;

/**
 * The confidence written on a Wikidata translation edge.
 *
 * 1.0 because this is an asserted sense-to-sense statement from the source, not
 * an inference of ours. It is the same meaning-to-meaning claim the schema's
 * `translations` table is built for, so there is nothing here to discount.
 */
const FULL_CONFIDENCE = 1;

interface WriteTranslationsInput {
  db: ImporterDb;
  sourceId: string;
  pairs: TranslationPair[];
  counter: DropCounter;
  dryRun: boolean;
}

/**
 * Resolve the staged pairs to sense ids and write both directions of each.
 *
 * WHY BOTH DIRECTIONS
 *   Wikidata records the statement on one side only: the English sense says it
 *   translates to the German one and the German sense frequently says nothing.
 *   A reader looking up the German word would then find no translation for a
 *   pair the database plainly holds. `translations` is unique on
 *   (from, to, source), so the two directions are two legitimate rows and the
 *   reverse of an edge upstream happens to state twice is absorbed by the
 *   conflict target rather than duplicated.
 *
 * WHY THE COUNT COMES FROM `RETURNING`
 *   It is the rows that really landed, never the rows offered. On a second run
 *   every row conflicts, `DO NOTHING` writes none of them, and this returns
 *   zero, which is what idempotent means here.
 *
 * @returns how many `translations` rows were newly written.
 */
async function writeTranslations(input: WriteTranslationsInput): Promise<number> {
  const uniquePairs = new Map<string, TranslationPair>();
  for (const pair of input.pairs) {
    if (pair.fromExternalId === pair.toExternalId) continue;
    uniquePairs.set(`${pair.fromExternalId}\t${pair.toExternalId}`, pair);
  }
  if (uniquePairs.size === 0) return 0;

  // A dry run counts what it WOULD offer, exactly as `flushBatch` does. It
  // cannot resolve anything, because resolution is a read against rows a dry
  // run never wrote, so this is an upper bound and reads as one.
  if (input.dryRun) return uniquePairs.size * DIRECTIONS_PER_PAIR;

  const externalIds = new Set<string>();
  for (const pair of uniquePairs.values()) {
    externalIds.add(pair.fromExternalId);
    externalIds.add(pair.toExternalId);
  }

  const senseIds = new Map<string, string>();
  for (const part of chunk([...externalIds], INSERT_CHUNK_SIZE)) {
    const rows = await input.db
      .select({ id: senses.id, externalId: senses.externalId })
      .from(senses)
      .where(and(eq(senses.sourceId, input.sourceId), inArray(senses.externalId, part)));

    for (const row of rows) {
      // `external_id` is nullable, for senses we mint ourselves. The filter
      // above cannot return one, so a null here would mean the database handed
      // back a row we did not ask for.
      if (row.externalId === null) continue;
      senseIds.set(row.externalId, row.id);
    }
  }

  // Keyed by the ordered id pair, because one pair contributes two rows and the
  // reverse of one edge is the forward of another whenever upstream stated both.
  // Two DISTINCT external ids can never resolve to one sense id, because
  // `senses` is unique on (source_id, external_id), so no self-row can be built
  // here that the pre-resolution guard above did not already remove.
  const rows = new Map<string, InsertTranslation>();
  for (const pair of uniquePairs.values()) {
    const fromSenseId = senseIds.get(pair.fromExternalId);
    const toSenseId = senseIds.get(pair.toExternalId);
    if (fromSenseId === undefined || toSenseId === undefined) {
      // Overwhelmingly a target in a language this importer does not keep, so
      // the sense row simply does not exist. It is counted rather than logged:
      // there are thousands of them and the shape of the loss is the signal.
      input.counter.drop('translation-target-missing');
      continue;
    }
    rows.set(`${fromSenseId}\t${toSenseId}`, {
      fromSenseId,
      toSenseId,
      sourceId: input.sourceId,
      confidence: FULL_CONFIDENCE,
    });
    rows.set(`${toSenseId}\t${fromSenseId}`, {
      fromSenseId: toSenseId,
      toSenseId: fromSenseId,
      sourceId: input.sourceId,
      confidence: FULL_CONFIDENCE,
    });
  }

  let written = 0;
  for (const part of chunk([...rows.values()], INSERT_CHUNK_SIZE)) {
    const inserted = await input.db
      .insert(translations)
      .values(part)
      .onConflictDoNothing({
        target: [translations.fromSenseId, translations.toSenseId, translations.sourceId],
      })
      .returning({ id: translations.id });
    written += inserted.length;
  }

  return written;
}

// =============================================================================
// Progress
// =============================================================================

interface ProgressInput {
  read: number;
  kept: number;
  startedAt: number;
}

/**
 * Write one progress line.
 *
 * A 1.58 million line dump run in silence is indistinguishable from a hung
 * process, and the run takes long enough that an operator will reach for
 * Ctrl-C. One line per 100000 entities is enough to show it is moving.
 *
 * It goes to stderr and never to stdout, because `--json` prints the summary as
 * a single JSON document on stdout and anything else written there would make
 * that output unparseable for whatever the operator piped it into.
 */
function reportProgress(input: ProgressInput): void {
  const seconds = Math.round((Date.now() - input.startedAt) / 1000);
  process.stderr.write(
    `wikidata-lexemes: read ${input.read}, kept ${input.kept}, ${seconds}s elapsed\n`,
  );
}

// =============================================================================
// The importer
// =============================================================================

export const wikidataLexemesImporter: Importer<ImportOptions> = {
  source,

  async run(options: ImportOptions): Promise<ImportSummary> {
    const startedAt = Date.now();
    // The dictionary tables are global and carry no organization id, so the raw
    // handle is the correct one. `tenantDb` would be wrong here, not merely
    // unnecessary: none of these tables is tenant-scoped.
    const db = getRawDb();
    const counter = createDropCounter();
    const languages = new Set(options.languages);

    source.version = dumpVersion(options.file);
    const sourceId = options.dryRun ? DRY_RUN_SOURCE_ID : await upsertSource(db, source);

    let read = 0;
    let kept = 0;
    const written: WriteCounts = { headwords: 0, senses: 0, senseVersions: 0, translations: 0 };
    let batch = emptyBatch();
    // Held for the whole run, not per batch: an edge is only resolvable once
    // both of its endpoints have sense rows, which is after the final flush.
    // The bound is documented above `writeTranslations`, a few thousand short
    // strings on the real dump.
    const translationPairs: TranslationPair[] = [];

    for await (const line of readLines(options.file)) {
      let parsed: DumpLine | null = null;
      try {
        parsed = parseDumpLine(line);
      } catch {
        counter.drop('parse');
        continue;
      }
      // A structural line is not a row. It is counted nowhere, so that `read`
      // means entities and can be compared against the dump's entity count.
      if (parsed === null) continue;

      // Checked before the increment, so `read` never reports more entities
      // than the operator asked for. Breaking out here also kills the
      // decompressor: the stream generator does that in its own cleanup.
      if (options.maxRows !== undefined && read >= options.maxRows) break;
      read += 1;
      if (read % PROGRESS_INTERVAL === 0) reportProgress({ read, kept, startedAt });

      const validated = LexemeSchema.safeParse(parsed.entity);
      if (!validated.success) {
        counter.drop('shape');
        continue;
      }
      const lexeme = validated.data;

      const languageCode = lexemeLanguageCode(lexeme.language);
      if (languageCode === null || !languages.has(languageCode)) {
        counter.drop('language');
        continue;
      }

      const lemma = pickLemma(lexeme, languageCode);
      if (lemma === null) {
        counter.drop('lemma-missing');
        continue;
      }

      kept += 1;
      const headword: InsertHeadword = {
        languageCode,
        lemma,
        lemmaNormalized: normalizeLemma(lemma),
        pos: mapLexicalCategory(lexeme.lexicalCategory),
        sourceId,
      };
      batch.headwords.push(headword);

      const glosses = collectGlosses({
        lexeme,
        headwordKey: headwordKeyOf(headword),
        languages,
        counter,
      });

      // Collected at the same point as the glosses, so only a KEPT lexeme
      // contributes: an edge hanging off a lexeme we dropped has no `from`
      // sense row to attach to and could never resolve.
      for (const pair of collectSenseTranslations(lexeme)) {
        translationPairs.push(pair);
      }

      // The headword is kept even when no gloss survived. A headword with no
      // sense is still worth having: it is what a fuzzy search matches on, and
      // a later enrichment pass attaches meanings to a headword that already
      // exists. Dropping it here would mean the word is simply not in the
      // dictionary, which is a worse answer than a word with no gloss yet.
      if (glosses.length === 0) counter.drop('no-gloss');
      for (const staged of glosses) {
        batch.glosses.push(staged);
      }

      if (batch.headwords.length >= INSERT_CHUNK_SIZE) {
        addCounts(written, await flushBatch({ db, sourceId, batch, dryRun: options.dryRun }));
        batch = emptyBatch();
      }
    }

    addCounts(written, await flushBatch({ db, sourceId, batch, dryRun: options.dryRun }));

    // Strictly after the FINAL flush, for the reason set out above
    // `writeTranslations`: both endpoints of an edge only have sense rows once
    // every batch has landed.
    written.translations += await writeTranslations({
      db,
      sourceId,
      pairs: translationPairs,
      counter,
      dryRun: options.dryRun,
    });

    return {
      read,
      // `written` is the SUM of four tables: headwords, senses, sense versions
      // and translations. It is not a row count of any one of them, and it will
      // be larger than the number of words imported, because one word carries
      // several glosses and each gloss is a sense plus a version.
      written: written.headwords + written.senses + written.senseVersions + written.translations,
      dropped: counter.count(),
      durationMs: Date.now() - startedAt,
    };
  },
};
