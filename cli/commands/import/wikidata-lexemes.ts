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
 *   The lemma, its language, its part of speech, and the glosses of its senses.
 *   Nothing else. `claims` and `forms` are the bulk of the bytes and none of
 *   them are in the schema, so they are not even described to the validator:
 *   an unmentioned field costs nothing, a described one costs a check on every
 *   entity of a 1.58 million line file.
 *
 * WHY THE LICENCE IS SAFE
 *   Wikidata lexicographical data is CC0, which is the only reason a gloss from
 *   it can be served with no attribution obligation attached to the reader. The
 *   licence is written on the source row and printed on every run, so a later
 *   audit can see under what terms these rows arrived.
 */

import { statSync } from 'node:fs';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { senses, senseVersions } from '#drizzle/schema';
import type { InsertHeadword, InsertSense, InsertSenseVersion } from '#drizzle/schema';
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
 * The shape we need from a lexeme, and nothing more.
 *
 * Validation happens here, at the I/O boundary, once per entity. Everything
 * downstream works on the parsed value and never re-checks a field.
 */
const LexemeSchema = z.object({
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
      }),
    )
    .optional(),
});

type Lexeme = z.infer<typeof LexemeSchema>;

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
// Staging: one sense row per gloss language
// =============================================================================
//
// THE DECISION, AND THE ALTERNATIVE THAT WAS REJECTED
//   One Wikidata sense usually carries glosses in several languages at once.
//   `L9-S1` alone has English, German, French, Spanish, Thai and Italian. The
//   question is what that becomes in our schema.
//
//   The obvious first answer is one `senses` row with several `sense_versions`
//   rows under it, one per language. It does not work. `sense_versions` is
//   unique on `(sense_id, version)`, so two glosses cannot both sit at version
//   1, and numbering them 1 and 2 would be a lie about what `version` means:
//   version is re-enrichment order, and the query layer reads `max(version)` as
//   the current text of a sense. Numbering languages would make the "current"
//   gloss whichever language happened to be written last, which is a language
//   picked at random, per sense, forever.
//
//   The milestone's own model settles it: a sense IS a language-specific gloss.
//   So this importer writes one `senses` row per (Wikidata sense, gloss
//   language) pair, each with exactly one `sense_versions` row at version 1.
//   `L9-S1` with six glosses becomes six sense rows, of which we keep the ones
//   in the languages we serve.
//
//   `senses.external_id` therefore carries the pair and not just the upstream
//   id: `L9-S1#de`. The unique constraint on `(source_id, external_id)` is what
//   makes the second run of this importer write nothing new, and the id has to
//   name the language for that constraint to separate the six rows.

/** A gloss staged for writing, before it has a headword id or a sense id. */
interface StagedGloss {
  /** Natural key of the headword this gloss hangs from, in the form `upsertHeadwords` returns. */
  headwordKey: string;
  /** `${wikidataSenseId}#${glossLanguage}`, the value written to `senses.external_id`. */
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
        externalId: `${sense.id}#${glossLanguage}`,
        glossLanguageCode: glossLanguage,
        gloss: gloss.value,
      });
    }
  }

  return staged;
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
 * WHY THE BATCH IS DE-DUPLICATED ON `externalId` FIRST
 *   Postgres raises "ON CONFLICT DO UPDATE command cannot affect row a second
 *   time" when one statement carries the same conflict key twice. The dump can
 *   present the same sense id more than once inside one batch, so the duplicate
 *   is removed before the statement is built.
 */
async function flushBatch(input: FlushInput): Promise<WriteCounts> {
  const counts: WriteCounts = { headwords: 0, senses: 0, senseVersions: 0 };
  if (input.batch.headwords.length === 0) return counts;

  const uniqueGlosses = new Map<string, StagedGloss>();
  for (const staged of input.batch.glosses) {
    uniqueGlosses.set(staged.externalId, staged);
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
    counts.senses = uniqueGlosses.size;
    counts.senseVersions = uniqueGlosses.size;
    return counts;
  }

  const headwordIds = await upsertHeadwords(input.db, input.batch.headwords);
  counts.headwords = headwordIds.size;

  const senseRows: InsertSense[] = [];
  for (const staged of uniqueGlosses.values()) {
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
      .onConflictDoNothing({ target: [senseVersions.senseId, senseVersions.version] })
      .returning({ id: senseVersions.id });
    counts.senseVersions += written.length;
  }

  return counts;
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
    const written: WriteCounts = { headwords: 0, senses: 0, senseVersions: 0 };
    let batch = emptyBatch();

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

    return {
      read,
      // `written` is the SUM of three tables: headwords, senses and sense
      // versions. It is not a row count of any one of them, and it will be
      // larger than the number of words imported, because one word carries
      // several glosses and each gloss is a sense plus a version.
      written: written.headwords + written.senses + written.senseVersions,
      dropped: counter.count(),
      durationMs: Date.now() - startedAt,
    };
  },
};
