/**
 * Import Tatoeba example sentences and their translations.
 *
 * THE LICENCE COLUMN THE SPEC ASKED FOR DOES NOT EXIST
 *   The spec said Tatoeba carries a per-row licence field to filter on. The
 *   dump does not have one. Filtering on a column that does not exist would
 *   have been a check that passes because it never runs. The licence is
 *   expressed instead by which of the two source rows an example is attached
 *   to.
 *
 *   The real columns of `sentences_detailed.csv`, verified against the
 *   downloaded dump, are:
 *
 *     id  lang  text  username  date_added  date_last_modified
 *
 *   Six columns, tab separated, and not one of them names a licence. Tatoeba's
 *   default for sentences and for links is CC BY 2.0 FR. The sentences whose
 *   contributors relicensed them are published as a SEPARATE export,
 *   `sentences_CC0.tar.bz2`, whose columns are:
 *
 *     id  lang  text  date_last_modified
 *
 *   So this importer writes TWO source rows and picks between them per example.
 *   An example carries two sentences, its own text and its translation, so it
 *   is recorded under `tatoeba-cc0` only when BOTH of those sentences appear in
 *   the CC0 export. Everything else is recorded under `tatoeba`, which is CC BY
 *   2.0 FR. See `buildExampleRow` for the exact rule.
 *
 * WHEN --cc0 IS NOT GIVEN, EVERYTHING IS CC BY
 *   Without the CC0 export we cannot know which sentences were relicensed, so
 *   every kept row goes to the `tatoeba` source. The safe default is the MORE
 *   restrictive licence, never the more permissive one. Labelling CC BY text as
 *   CC0 would tell every downstream reader that they may drop the attribution,
 *   and that error cannot be taken back once the data has been served.
 *
 * WHY THE IMPORTER EXPOSES ONLY ONE SOURCE
 *   `Importer.source` is a single object, and `printSummary` prints it. The CC
 *   BY source is the one exposed, because it covers most rows. The CC0 source
 *   exists beside it, is written by the same run, and its row count is printed
 *   to stderr at the end of the run. The summary contract has room for drops
 *   and for one total written, not for a per-source breakdown, so stderr is
 *   where that number goes rather than being bent into a drop reason it is not.
 */

import { sql } from 'drizzle-orm';
import { examples } from '#drizzle/schema';
import { getRawDb } from '#drizzle/tenant-db';
import {
  createDropCounter,
  type DropCounter,
  type ImportOptions,
  type ImportSummary,
  type Importer,
  type ImporterSource,
} from '../../lib/importers/contract';
import { tokenize } from '../../lib/importers/normalize';
import { readLines } from '../../lib/importers/stream';
import { INSERT_CHUNK_SIZE, upsertSource, type ImporterDb } from '../../lib/importers/upsert';

export interface TatoebaImportOptions extends ImportOptions {
  /** Path to links.tar.bz2 (or the extracted links.csv). */
  links: string;
  /** Path to sentences_CC0.tar.bz2. Optional. */
  cc0?: string;
}

/** The dump date this importer was last checked against. Tatoeba publishes weekly. */
const TATOEBA_VERSION = '2026-08';

const TATOEBA_CC_BY_SOURCE: ImporterSource = {
  slug: 'tatoeba',
  name: 'Tatoeba',
  url: 'https://tatoeba.org/en/downloads',
  licence: 'CC-BY-2.0-FR',
  attribution: 'Tatoeba sentences, CC BY 2.0 FR, https://tatoeba.org/en/sentences/show/<id>',
  version: TATOEBA_VERSION,
};

const TATOEBA_CC0_SOURCE: ImporterSource = {
  slug: 'tatoeba-cc0',
  name: 'Tatoeba (CC0 sentences)',
  url: 'https://tatoeba.org/en/downloads',
  licence: 'CC0-1.0',
  attribution:
    'Tatoeba sentences released under CC0, https://tatoeba.org/en/sentences/show/<id>',
  version: TATOEBA_VERSION,
};

/**
 * Tatoeba writes ISO 639-3, the dictionary stores ISO 639-1.
 *
 * Only these four are mapped, because these four are the languages the
 * dictionary serves. Everything else returns null and is dropped, rather than
 * being passed through as a code no `languages` row exists for, which would
 * fail on the foreign key hundreds of thousands of rows into a run.
 *
 * A Map, not a plain object, because the keys come from a downloaded file and a
 * Map has no prototype keys for a line like `constructor` to collide with.
 */
export const ISO3_TO_CODE = new Map<string, string>([
  ['eng', 'en'],
  ['deu', 'de'],
  ['tur', 'tr'],
  ['spa', 'es'],
]);

/** The dictionary code for a Tatoeba language, or null when we do not serve it. */
export function tatoebaLanguageCode(iso3: string): string | null {
  return ISO3_TO_CODE.get(iso3) ?? null;
}

/** The three leading fields of a sentence line. The rest of the line is metadata we do not store. */
export interface TatoebaSentence {
  id: string;
  iso3: string;
  text: string;
}

/**
 * Parse one line of a Tatoeba sentence export.
 *
 * The same function reads both exports. `sentences_detailed` has six columns
 * and `sentences_CC0` has four, but the first three are `id`, `lang` and `text`
 * in both, and those three are all this importer stores. Anything with fewer
 * than three fields is not a sentence line and returns null, which the caller
 * counts as a `malformed` drop.
 */
export function parseSentenceLine(line: string): TatoebaSentence | null {
  const fields = line.split('\t');
  if (fields.length < 3) return null;

  const [id, iso3, text] = fields;
  if (id === undefined || iso3 === undefined || text === undefined) return null;
  if (id === '' || iso3 === '' || text === '') return null;

  return { id, iso3, text };
}

/** How often a long pass prints a line of progress. */
const PROGRESS_EVERY = 500_000;

/**
 * Say where the run is.
 *
 * On stderr, always. `--json` writes the summary to stdout and an operator
 * pipes that into `jq`, so a progress line on stdout would corrupt the very
 * output the flag exists to produce.
 */
function reportProgress(pass: string, lines: number, startedAt: number): void {
  const seconds = Math.round((Date.now() - startedAt) / 1000);
  console.error(`[tatoeba] ${pass}: ${lines} lines, ${seconds}s`);
}

/**
 * The sentences we kept from pass 1, as two parallel maps.
 *
 * TWO MAPS OF STRINGS, NOT ONE MAP OF OBJECTS
 *   Every object here would be a separate heap allocation with its own header
 *   and its own hidden class, on top of the two strings it holds. Four million
 *   of them is a large amount of memory spent on wrapping. Two maps hold the
 *   same two strings per id and allocate nothing around them.
 */
interface KeptSentences {
  codeById: Map<string, string>;
  textById: Map<string, string>;
  /** Sentence lines read, kept and dropped alike. This is what `ImportSummary.read` reports. */
  read: number;
}

/**
 * Pass 1: read the sentence table into memory.
 *
 * WHY THIS HAS TO BE IN MEMORY, AND WHAT IT COSTS
 *   Pass 2 reads the links file, which is nothing but pairs of ids. To turn a
 *   pair into an example row we need the language and the text of both sides,
 *   and the links file carries neither. Either we hold the sentences, or we
 *   look each one up in the dump again, which is a second full scan per link.
 *
 *   Our four languages hold about 4.0 million of the 14 million sentences in
 *   the dump: roughly 2.04M English, 0.78M German, 0.75M Turkish and 0.44M
 *   Spanish. Held as ids, codes and texts that is close to a gigabyte of heap.
 *   A full run therefore needs Node's heap raised, for example
 *   `NODE_OPTIONS=--max-old-space-size=4096`, and it will die with an
 *   out-of-memory error without it. This is not free and it should not be sold
 *   as free.
 *
 *   `--max-rows` is the knob that makes a run fit on a laptop. It caps THIS
 *   pass specifically: it limits how many sentence lines are read, which is
 *   what limits the memory. It does not cap pass 2, which streams and holds
 *   only one batch at a time.
 */
async function readSentences(
  options: TatoebaImportOptions,
  wanted: Set<string>,
  counter: DropCounter,
  startedAt: number,
): Promise<KeptSentences> {
  const codeById = new Map<string, string>();
  const textById = new Map<string, string>();
  let read = 0;

  for await (const line of readLines(options.file)) {
    if (line === '') continue;

    read += 1;
    if (read % PROGRESS_EVERY === 0) {
      reportProgress('pass 1 sentences', read, startedAt);
    }

    const sentence = parseSentenceLine(line);
    if (sentence === null) {
      counter.drop('malformed');
    } else {
      const code = tatoebaLanguageCode(sentence.iso3);
      if (code === null || !wanted.has(code)) {
        counter.drop('language');
      } else {
        codeById.set(sentence.id, code);
        textById.set(sentence.id, sentence.text);
      }
    }

    if (options.maxRows !== undefined && read >= options.maxRows) break;
  }

  reportProgress('pass 1 sentences done', read, startedAt);
  return { codeById, textById, read };
}

/**
 * What the CC0 export says about one sentence.
 *
 * The language and the text are both kept, not just the id. The two exports are
 * separate snapshots taken at separate times, so a sentence can have been
 * edited, or re-tagged, between them, and pass 2 needs to see that. One small
 * object per sentence is affordable here in a way it is not in pass 1: this map
 * holds about 41500 entries across our four languages, not four million.
 */
interface Cc0Sentence {
  code: string;
  text: string;
}

/**
 * Pass 0: what the CC0 export says, by sentence id.
 *
 * Sentences in a language we do not keep are skipped. That narrows what the
 * contradiction check in pass 2 can see: if the CC0 export tags a sentence as a
 * language we do not serve while the main dump tags it as one we do, we will not
 * notice, and the row will simply be recorded under the CC BY source. That is
 * the safe direction of the miss, because it labels the row with the more
 * restrictive licence.
 */
async function readCc0Sentences(
  file: string,
  wanted: Set<string>,
  startedAt: number,
): Promise<Map<string, Cc0Sentence>> {
  const byId = new Map<string, Cc0Sentence>();
  let read = 0;

  for await (const line of readLines(file)) {
    if (line === '') continue;

    read += 1;
    if (read % PROGRESS_EVERY === 0) {
      reportProgress('pass 0 cc0', read, startedAt);
    }

    const sentence = parseSentenceLine(line);
    if (sentence === null) continue;

    const code = tatoebaLanguageCode(sentence.iso3);
    if (code === null || !wanted.has(code)) continue;

    byId.set(sentence.id, { code, text: sentence.text });
  }

  reportProgress('pass 0 cc0 done', read, startedAt);
  return byId;
}

/**
 * One example row, before it is written.
 *
 * `externalId` is required here although the column is nullable, because every
 * row this importer builds has one and the upsert conflict target depends on
 * it. Declaring it required means the code that reads it back after the insert
 * needs no null check for a case that cannot happen.
 */
interface ExampleRow {
  externalId: string;
  languageCode: string;
  text: string;
  translationLanguageCode: string;
  translationText: string;
  sourceId: string;
}

/** What one flushed batch wrote. */
interface BatchResult {
  examplesWritten: number;
  attachmentsWritten: number;
}

/**
 * Write one batch of examples and attach them to headwords.
 *
 * WHY THE INSERT IS `onConflictDoUpdate` AND NOT `onConflictDoNothing`
 *   `DO NOTHING` returns no row for a conflicting insert, so on a second run
 *   `RETURNING` gives back nothing and every example id needed for the
 *   attachment step is lost. `DO UPDATE` touches the row, which makes it a
 *   returned row, so both the new and the pre-existing ids come back. This is
 *   the same trap `upsertHeadwords` documents, in the same shape.
 *
 * WHY THE BATCH IS DE-DUPLICATED FIRST
 *   Postgres raises "ON CONFLICT DO UPDATE command cannot affect row a second
 *   time" when one statement carries the same conflict key twice. The caller
 *   already keys its pending rows on (sourceId, externalId), so the batch that
 *   arrives here is unique by construction, and the map below is what makes
 *   that true rather than hoped for.
 */
async function writeBatch(db: ImporterDb, rows: ExampleRow[]): Promise<BatchResult> {
  if (rows.length === 0) return { examplesWritten: 0, attachmentsWritten: 0 };

  const written = await db
    .insert(examples)
    .values(rows)
    .onConflictDoUpdate({
      target: [examples.sourceId, examples.externalId],
      set: { text: sql`excluded.text` },
    })
    .returning({ id: examples.id, externalId: examples.externalId });

  const byExternalId = new Map<string, ExampleRow>();
  for (const row of rows) {
    byExternalId.set(row.externalId, row);
  }

  const exampleIds: string[] = [];
  const tokens: string[] = [];
  const languageCodes: string[] = [];

  for (const row of written) {
    if (row.externalId === null) {
      throw new Error(`Example ${row.id} came back with no external id, which cannot happen.`);
    }
    const source = byExternalId.get(row.externalId);
    if (source === undefined) {
      throw new Error(`Example ${row.externalId} came back from an insert that did not send it.`);
    }
    for (const token of tokenize(source.text)) {
      exampleIds.push(row.id);
      tokens.push(token);
      languageCodes.push(source.languageCode);
    }
  }

  const attachmentsWritten = await attachHeadwords(db, exampleIds, tokens, languageCodes);
  return { examplesWritten: written.length, attachmentsWritten };
}

/**
 * Attach a batch of examples to every headword their words match.
 *
 * WHY THE JOIN IS IN SQL AND NOT IN TYPESCRIPT
 *   There are millions of headwords and millions of sentences. A JavaScript
 *   loop that asks "which headwords does this sentence mention" one sentence at
 *   a time is a cross product with a round trip in the middle, and it never
 *   finishes. This is ONE statement per batch: the three parallel arrays are
 *   unnested into a table of (example, token, language) rows, and Postgres
 *   joins that against the headword index it already has.
 *
 * WHY BOTH SIDES ARE NORMALIZED IN TYPESCRIPT
 *   The tokens are produced by `tokenize`, which calls `normalizeLemma`, which
 *   is the same function that wrote `headwords.lemma_normalized` on import. One
 *   implementation on both sides of the equality. The alternative, normalizing
 *   the stored side in TypeScript and the query side with Postgres `unaccent`,
 *   puts two different normalizers on the two sides of an `=`. They agree on
 *   most rows and disagree on the edges, no row fails, no error is raised, and
 *   the matches that are lost are lost silently. Nothing would ever tell us.
 *
 * WHY `sql.param` AND NOT PLAIN INTERPOLATION
 *   drizzle-orm 0.39.3 exports `sql.param`, and it is what makes the array a
 *   bound parameter rather than something the tag has to decide about. The
 *   explicit call also documents that these are values, next to the `::uuid[]`
 *   and `::text[]` casts that tell Postgres how to read them.
 *
 * THE RETURNED COUNT IS LANDED, NOT OFFERED
 *   `ON CONFLICT DO NOTHING ... RETURNING` gives back only the rows that were
 *   really inserted. A re-run offers the same pairs, the composite primary key
 *   on (example_id, headword_id) already holds them, none are inserted, and the
 *   count is zero. So this number is attachments that landed.
 */
async function attachHeadwords(
  db: ImporterDb,
  exampleIds: string[],
  tokens: string[],
  languageCodes: string[],
): Promise<number> {
  if (exampleIds.length === 0) return 0;

  const attached = await db.execute(sql`
    INSERT INTO example_headwords (example_id, headword_id)
    SELECT DISTINCT t.example_id, h.id
    FROM unnest(
      ${sql.param(exampleIds)}::uuid[],
      ${sql.param(tokens)}::text[],
      ${sql.param(languageCodes)}::text[]
    ) AS t(example_id, token, language_code)
    JOIN headwords h
      ON h.lemma_normalized = t.token
     AND h.language_code = t.language_code
    ON CONFLICT DO NOTHING
    RETURNING example_id
  `);

  return attached.rows.length;
}

/** What pass 2 produced, across every batch. */
interface WriteTotals {
  examplesWritten: number;
  attachmentsWritten: number;
  cc0Examples: number;
}

/**
 * Pass 2: read the links, build the rows, write them.
 *
 * WHY BOTH DIRECTIONS OF EVERY PAIR ARE KEPT
 *   The links file lists 330998 -> 872717 and 872717 -> 330998 as two lines,
 *   and this importer keeps both. That is on purpose and it is not a bug. An
 *   example row holds one sentence as `text` and the other as
 *   `translationText`, and a German headword needs the German sentence in
 *   `text` with the English one beside it, while an English headword needs the
 *   mirror of that. One row cannot serve both, so there are two, and the row
 *   count is double the pair count by design.
 */
async function readLinksAndWrite(
  options: TatoebaImportOptions,
  kept: KeptSentences,
  cc0ById: Map<string, Cc0Sentence>,
  sourceIds: Map<string, string>,
  counter: DropCounter,
  startedAt: number,
): Promise<WriteTotals> {
  const db = getRawDb();
  // A dry run wrote no source rows, so it has no uuids to point at. The slug
  // stands in for the uuid there. It never reaches the database: a dry run
  // returns from `flush` before the insert, and the only other use of the value
  // is telling the two sources apart while counting.
  const ccBySourceId = sourceIds.get(TATOEBA_CC_BY_SOURCE.slug) ?? TATOEBA_CC_BY_SOURCE.slug;
  const cc0SourceId = sourceIds.get(TATOEBA_CC0_SOURCE.slug) ?? TATOEBA_CC0_SOURCE.slug;

  const totals: WriteTotals = { examplesWritten: 0, attachmentsWritten: 0, cc0Examples: 0 };
  // Keyed on (sourceId, externalId), which is the conflict target of the insert.
  // Building the batch in a Map is what guarantees the statement cannot carry
  // the same key twice.
  const pending = new Map<string, ExampleRow>();
  let read = 0;

  const flush = async (): Promise<void> => {
    if (pending.size === 0) return;
    const batch = [...pending.values()];
    pending.clear();
    if (options.dryRun) return;
    const result = await writeBatch(db, batch);
    totals.examplesWritten += result.examplesWritten;
    totals.attachmentsWritten += result.attachmentsWritten;
  };

  for await (const line of readLines(options.links)) {
    if (line === '') continue;

    read += 1;
    if (read % PROGRESS_EVERY === 0) {
      reportProgress('pass 2 links', read, startedAt);
    }

    const row = buildExampleRow(line, kept, cc0ById, ccBySourceId, cc0SourceId, counter);
    if (row === null) continue;

    if (row.sourceId === cc0SourceId) totals.cc0Examples += 1;
    // A dry run counts the row it would have written, because the whole point
    // of the flag is to learn how many rows a real run would produce.
    if (options.dryRun) totals.examplesWritten += 1;

    pending.set(`${row.sourceId}\t${row.externalId}`, row);
    if (pending.size >= INSERT_CHUNK_SIZE) {
      await flush();
    }
  }

  await flush();
  reportProgress('pass 2 links done', read, startedAt);
  return totals;
}

/**
 * Turn one link line into one directed example row, or drop it and say why.
 *
 * A ROW IS CC0 ONLY WHEN BOTH OF ITS TEXTS ARE CC0
 *   An example row carries two sentences: one in `text`, one in
 *   `translationText`. Choosing the source from the `text` side alone would
 *   file a CC BY translation under a CC0 source row, and every reader would
 *   then be told they may reuse that translation without attribution. So the
 *   CC0 source is used only when BOTH ids appear in the CC0 export AND both
 *   stored texts still match what that export published. Everything else is CC
 *   BY. The more restrictive licence wins in every unclear case, because the
 *   permissive mistake cannot be taken back once the row has been served.
 *
 *   This is stricter than the spec asked for. The spec chose the source from
 *   the sentence side alone, which is the side the row is about, and that reads
 *   sensibly until you notice the second text sitting in the same row under the
 *   same one licence label. The fixtures in `tests/fixtures/importers/` do hold
 *   one fully CC0 pair, sentences 7843793 and 7844067, so the CC0 branch is
 *   exercised there in both link directions. That pair had to be found by
 *   searching the real CC0 export for a link whose BOTH endpoints are listed in
 *   it. Such pairs are not common: most CC0 sentences are linked to CC BY
 *   partners, which is exactly the situation this rule exists to handle.
 *
 * WHERE THE `licence` DROP IS USED
 *   When the CC0 export and the main dump disagree about the LANGUAGE of the
 *   same sentence id, the two exports contradict each other about the row we
 *   are about to write, and neither is evidently right. Writing it would store
 *   a text under a language code one of the two exports denies. So the row is
 *   refused and counted under `licence`. This is a check that really runs
 *   against real data on every pass, unlike filtering on the per-row licence
 *   column the dump does not have.
 */
function buildExampleRow(
  line: string,
  kept: KeptSentences,
  cc0ById: Map<string, Cc0Sentence>,
  ccBySourceId: string,
  cc0SourceId: string,
  counter: DropCounter,
): ExampleRow | null {
  const fields = line.split('\t');
  const sentenceId = fields[0];
  const translationId = fields[1];
  if (sentenceId === undefined || translationId === undefined) {
    counter.drop('malformed');
    return null;
  }
  if (sentenceId === '' || translationId === '') {
    counter.drop('malformed');
    return null;
  }

  const languageCode = kept.codeById.get(sentenceId);
  const translationLanguageCode = kept.codeById.get(translationId);
  if (languageCode === undefined || translationLanguageCode === undefined) {
    // One side of the pair is in a language we do not keep, or fell outside
    // `--max-rows`. Either way we cannot build the row.
    counter.drop('unlinked');
    return null;
  }

  if (languageCode === translationLanguageCode) {
    // Tatoeba links paraphrases within one language too. Those are not
    // translations and have no place in a translation example.
    counter.drop('same-language');
    return null;
  }

  const text = kept.textById.get(sentenceId);
  const translationText = kept.textById.get(translationId);
  if (text === undefined || translationText === undefined) {
    counter.drop('unlinked');
    return null;
  }

  const cc0Sentence = cc0ById.get(sentenceId);
  const cc0Translation = cc0ById.get(translationId);
  if (
    (cc0Sentence !== undefined && cc0Sentence.code !== languageCode) ||
    (cc0Translation !== undefined && cc0Translation.code !== translationLanguageCode)
  ) {
    counter.drop('licence');
    return null;
  }

  const isCc0 =
    cc0Sentence !== undefined &&
    cc0Translation !== undefined &&
    cc0Sentence.text === text &&
    cc0Translation.text === translationText;

  return {
    externalId: `${sentenceId}:${translationId}`,
    languageCode,
    text,
    translationLanguageCode,
    translationText,
    // Attachment is through `example_headwords`, so `senseId` and `headwordId`
    // are both left null: one sentence mentions several words, and a single
    // column cannot say that.
    sourceId: isCc0 ? cc0SourceId : ccBySourceId,
  };
}

/**
 * Run the import.
 *
 * `written` is examples written plus attachments landed. Those are two
 * different tables and one number, because the contract has one number. An
 * example row without its attachments is invisible to every reader, so the two
 * halves are one unit of work and reporting only the examples would overstate
 * how much of the job is done.
 */
async function run(options: TatoebaImportOptions): Promise<ImportSummary> {
  const startedAt = Date.now();
  const counter = createDropCounter();
  const wanted = new Set(options.languages);

  const cc0ById =
    options.cc0 === undefined
      ? new Map<string, Cc0Sentence>()
      : await readCc0Sentences(options.cc0, wanted, startedAt);

  const kept = await readSentences(options, wanted, counter, startedAt);

  const sourceIds = new Map<string, string>();
  if (!options.dryRun) {
    const db = getRawDb();
    sourceIds.set(TATOEBA_CC_BY_SOURCE.slug, await upsertSource(db, TATOEBA_CC_BY_SOURCE));
    sourceIds.set(TATOEBA_CC0_SOURCE.slug, await upsertSource(db, TATOEBA_CC0_SOURCE));
  }

  const totals = await readLinksAndWrite(
    options,
    kept,
    cc0ById,
    sourceIds,
    counter,
    startedAt,
  );

  // The CC0 count goes to stderr because `ImportSummary` has no room for it.
  // `written` is one number and `dropped` is for drops, and a CC0 row is not a
  // drop. Bending it into a drop reason would make the summary say rows were
  // lost when they were written, which is worse than printing it beside.
  console.error(
    `[tatoeba] examples recorded under ${TATOEBA_CC0_SOURCE.slug} (${TATOEBA_CC0_SOURCE.licence}): ${totals.cc0Examples}`,
  );
  if (options.cc0 === undefined) {
    console.error(
      '[tatoeba] --cc0 was not given, so every row was recorded under the CC BY source.',
    );
  }

  return {
    read: kept.read,
    written: totals.examplesWritten + totals.attachmentsWritten,
    dropped: counter.count(),
    durationMs: Date.now() - startedAt,
  };
}

export const tatoebaImporter: Importer<TatoebaImportOptions> = {
  source: TATOEBA_CC_BY_SOURCE,
  run,
};
