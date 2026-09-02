/**
 * One entry page: a headword, its senses, every gloss those senses carry, the
 * translations they point at, and the sentences that use the word.
 *
 * THE TWO RULES OF `queries.server.ts` APPLY HERE UNCHANGED.
 *   1. THE DATABASE IS A PARAMETER, NEVER AN IMPORT, because `drizzle/db.ts`
 *      opens a pool at module load.
 *   2. THE LICENCE FILTER LIVES IN THE SQL, in every statement, never as a
 *      `.filter()` over the rows that came back.
 *
 * EVERY LANGUAGE'S GLOSS, NOT JUST THE TARGET'S.
 *   The search result card shows one gloss, in the language the reader is
 *   translating INTO, because a card has room for one line. The entry page is
 *   the surface that exists to show the whole record, so it carries the current
 *   gloss in every language the sense has one in and lets the UI decide what to
 *   render. Narrowing here would make the extra languages unreachable from any
 *   screen, while they sit in the table.
 *
 * A MISSING ENTRY IS A RETURNED `null`, NOT A THROW.
 *   An id that resolves to nothing is an ordinary thing for a public URL to
 *   carry: a typo, an old bookmark, a link from a page that outlived the row.
 *   The caller renders a warm page from the `null`. A thrown error would turn
 *   every one of those into a 500 and into noise in the error tracker.
 */

import { and, asc, eq, inArray, or } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import {
  exampleHeadwords,
  examples,
  headwords,
  senseVersions,
  senses,
  sources,
  translations,
} from '#drizzle/schema';
import type { LanguageCode } from './detect-language';
import { SERVED_LICENCES } from './licences';
import { currentSenseVersions, currentVersionColumn, type DictionaryDb } from './queries.server';
import { collectExamples, type ExampleRow } from './search.server';

/** How many usage sentences one entry page carries. */
export const EXAMPLE_LIMIT = 5;

/**
 * The licence predicate, as SQL. The local equivalent of the private helper in
 * `queries.server.ts`; see the note there on why it is never a JavaScript
 * filter.
 */
function servedLicence() {
  return inArray(sources.licence, [...SERVED_LICENCES]);
}

// =============================================================================
// The result shape
// =============================================================================

/** The current gloss of one sense in one language. */
export interface EntryGloss {
  languageCode: string;
  gloss: string;
  sourceSlug: string;
  attribution: string;
}

/** One sense-level edge into the target language. */
export interface EntryTranslation {
  headwordId: string;
  lemma: string;
  languageCode: string;
  sourceSlug: string;
  attribution: string;
}

/** One meaning of the headword, with its wording and its edges. */
export interface EntrySense {
  senseId: string;
  glosses: EntryGloss[];
  translations: EntryTranslation[];
}

/** One usage sentence shown on the entry page. */
export interface EntryExample {
  id: string;
  text: string;
  languageCode: string;
  translationText: string | null;
  translationLanguageCode: string | null;
  sourceSlug: string;
  attribution: string;
}

/** The whole entry page, in one object. */
export interface EntryView {
  headwordId: string;
  lemma: string;
  pos: string | null;
  languageCode: string;
  senses: EntrySense[];
  examples: EntryExample[];
}

export interface GetEntryParams {
  headwordId: string;
  to: LanguageCode;
}

// =============================================================================
// The queries
// =============================================================================

/** The headword itself, licence-filtered in SQL. Returned un-awaited. */
export function entryHeadwordQuery(db: DictionaryDb, headwordId: string) {
  return db
    .select({
      headwordId: headwords.id,
      lemma: headwords.lemma,
      pos: headwords.pos,
      languageCode: headwords.languageCode,
    })
    .from(headwords)
    .innerJoin(sources, eq(headwords.sourceId, sources.id))
    .where(and(eq(headwords.id, headwordId), servedLicence()))
    .limit(1);
}

/**
 * The senses of one headword, licence-filtered in SQL.
 *
 * Ordered by id so the page lists its senses in the same order on every
 * request. Row order is not an ordering, and a page whose sections move between
 * two identical requests is unreportable as a bug.
 */
export function entrySensesQuery(db: DictionaryDb, headwordId: string) {
  return db
    .select({ senseId: senses.id })
    .from(senses)
    .innerJoin(sources, eq(senses.sourceId, sources.id))
    .where(and(eq(senses.headwordId, headwordId), servedLicence()))
    .orderBy(asc(senses.id));
}

/**
 * The CURRENT gloss of each sense in EVERY language, licence-filtered in SQL.
 *
 * The join matches `currentSenseVersions` on BOTH `sense_id` and
 * `gloss_language_code`. Matching on the sense alone would collapse the
 * languages into one maximum and keep whichever language happened to be
 * re-enriched last.
 *
 * The version leg of the join uses `currentVersionColumn`, the qualified SQL
 * reference, rather than the aggregate read off the subquery handle. Drizzle
 * renders the handle form as a bare name, which Postgres cannot resolve here.
 */
export function entryGlossesQuery(db: DictionaryDb, senseIds: string[]) {
  const current = currentSenseVersions(db);
  return db
    .select({
      senseId: senseVersions.senseId,
      languageCode: senseVersions.glossLanguageCode,
      gloss: senseVersions.gloss,
      sourceSlug: sources.slug,
      attribution: sources.attribution,
    })
    .from(senseVersions)
    .innerJoin(
      current,
      and(
        eq(current.senseId, senseVersions.senseId),
        eq(current.glossLanguageCode, senseVersions.glossLanguageCode),
        eq(currentVersionColumn, senseVersions.version),
      ),
    )
    .innerJoin(sources, eq(senseVersions.sourceId, sources.id))
    .where(and(inArray(senseVersions.senseId, senseIds), servedLicence()))
    .orderBy(asc(senseVersions.glossLanguageCode));
}

/**
 * The sense-level edges into one language, licence-filtered in SQL on BOTH
 * sides: the source that asserted the edge, and the source that supplied the
 * target lemma. The lemma is content that reaches the page.
 *
 * Edges are written in both directions, so `from_sense_id` alone reaches every
 * partner.
 */
export function entryTranslationsQuery(
  db: DictionaryDb,
  params: { senseIds: string[]; to: LanguageCode },
) {
  const targetSenses = alias(senses, 'target_senses');
  const targetHeadwords = alias(headwords, 'target_headwords');
  const targetSources = alias(sources, 'target_sources');
  return db
    .select({
      fromSenseId: translations.fromSenseId,
      headwordId: targetHeadwords.id,
      lemma: targetHeadwords.lemma,
      languageCode: targetHeadwords.languageCode,
      sourceSlug: sources.slug,
      attribution: sources.attribution,
    })
    .from(translations)
    .innerJoin(targetSenses, eq(translations.toSenseId, targetSenses.id))
    .innerJoin(targetHeadwords, eq(targetSenses.headwordId, targetHeadwords.id))
    .innerJoin(targetSources, eq(targetHeadwords.sourceId, targetSources.id))
    .innerJoin(sources, eq(translations.sourceId, sources.id))
    .where(
      and(
        inArray(translations.fromSenseId, params.senseIds),
        eq(targetHeadwords.languageCode, params.to),
        servedLicence(),
        inArray(targetSources.licence, [...SERVED_LICENCES]),
      ),
    )
    .orderBy(asc(targetHeadwords.lemma));
}

/** Examples attached to this headword through the junction, licence-filtered in SQL. */
export function entryJunctionExamplesQuery(db: DictionaryDb, headwordId: string) {
  return db
    .select({
      headwordId: exampleHeadwords.headwordId,
      id: examples.id,
      text: examples.text,
      languageCode: examples.languageCode,
      translationText: examples.translationText,
      translationLanguageCode: examples.translationLanguageCode,
      sourceSlug: sources.slug,
      attribution: sources.attribution,
    })
    .from(exampleHeadwords)
    .innerJoin(examples, eq(exampleHeadwords.exampleId, examples.id))
    .innerJoin(sources, eq(examples.sourceId, sources.id))
    .where(and(eq(exampleHeadwords.headwordId, headwordId), servedLicence()))
    .orderBy(asc(examples.id))
    .limit(EXAMPLE_LIMIT);
}

/**
 * Examples attached directly, either to this headword or to one of its senses,
 * licence-filtered in SQL.
 *
 * The `headwordId` column of the result is filled with the entry's own id
 * rather than with `examples.headword_id`, because a sense-attached row carries
 * NULL there and would otherwise be dropped when the rows are grouped.
 */
export function entryDirectExamplesQuery(
  db: DictionaryDb,
  params: { headwordId: string; senseIds: string[] },
) {
  return db
    .select({
      id: examples.id,
      text: examples.text,
      languageCode: examples.languageCode,
      translationText: examples.translationText,
      translationLanguageCode: examples.translationLanguageCode,
      sourceSlug: sources.slug,
      attribution: sources.attribution,
    })
    .from(examples)
    .innerJoin(sources, eq(examples.sourceId, sources.id))
    .where(
      and(
        // The sense arm is dropped rather than passed an empty list, because
        // `in ()` is not valid SQL. The headword arm always stands.
        params.senseIds.length > 0
          ? or(
              eq(examples.headwordId, params.headwordId),
              inArray(examples.senseId, params.senseIds),
            )
          : eq(examples.headwordId, params.headwordId),
        servedLicence(),
      ),
    )
    .orderBy(asc(examples.id))
    .limit(EXAMPLE_LIMIT);
}

// =============================================================================
// Assembly
// =============================================================================

/** A gloss row before it is grouped under its sense. */
interface GlossRow {
  senseId: string;
  languageCode: string;
  gloss: string;
  sourceSlug: string;
  attribution: string;
}

/** A translation row before it is grouped under its sense. */
interface EntryTranslationRow {
  fromSenseId: string;
  headwordId: string;
  lemma: string;
  languageCode: string;
  sourceSlug: string;
  attribution: string;
}

/**
 * Group glosses under their sense.
 *
 * A Map rather than an accumulator object: an object built by assignment is an
 * open dictionary, and a Map says the same thing with a real key type.
 */
function collectGlosses(rows: GlossRow[]): Map<string, EntryGloss[]> {
  const bySense = new Map<string, EntryGloss[]>();
  for (const row of rows) {
    const bucket = bySense.get(row.senseId) ?? [];
    bucket.push({
      languageCode: row.languageCode,
      gloss: row.gloss,
      sourceSlug: row.sourceSlug,
      attribution: row.attribution,
    });
    bySense.set(row.senseId, bucket);
  }
  return bySense;
}

/**
 * Group translations under their sense, de-duplicated by lemma.
 *
 * The lemma is the key rather than the target headword id, because the same
 * word imported by two sources is two rows and one word to a reader.
 */
function collectSenseTranslations(rows: EntryTranslationRow[]): Map<string, EntryTranslation[]> {
  const bySense = new Map<string, EntryTranslation[]>();
  const seen = new Set<string>();
  for (const row of rows) {
    const key = `${row.fromSenseId} ${row.lemma}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const bucket = bySense.get(row.fromSenseId) ?? [];
    bucket.push({
      headwordId: row.headwordId,
      lemma: row.lemma,
      languageCode: row.languageCode,
      sourceSlug: row.sourceSlug,
      attribution: row.attribution,
    });
    bySense.set(row.fromSenseId, bucket);
  }
  return bySense;
}

/**
 * Read one entry.
 *
 * BOUNDED STATEMENTS, NEVER ONE PER SENSE. The sense ids are gathered first and
 * each relation is a single `inArray` statement over all of them, so an entry
 * with twenty senses costs the same five round trips as one with a single
 * sense.
 *
 * @param db The dictionary database handle.
 * @param params The headword id from the URL and the language to translate into.
 * @returns The whole entry, or `null` when the id addresses no servable row.
 */
export async function getEntry(
  db: DictionaryDb,
  params: GetEntryParams,
): Promise<EntryView | null> {
  const headwordRows = await entryHeadwordQuery(db, params.headwordId);
  const headword = headwordRows[0];
  // Unknown id, retired row, or a row whose licence may not be served: all
  // three are a page that does not exist, and the caller renders that.
  if (!headword) return null;
  const senseRows = await entrySensesQuery(db, params.headwordId);
  const senseIds = senseRows.map((row) => row.senseId);
  const [glossRows, translationRows, junctionRows, directRows] = await Promise.all([
    senseIds.length > 0 ? entryGlossesQuery(db, senseIds) : [],
    senseIds.length > 0 ? entryTranslationsQuery(db, { senseIds, to: params.to }) : [],
    entryJunctionExamplesQuery(db, params.headwordId),
    entryDirectExamplesQuery(db, { headwordId: params.headwordId, senseIds }),
  ]);
  const glossesBySense = collectGlosses(glossRows);
  const translationsBySense = collectSenseTranslations(translationRows);
  // The direct rows carry no headword column of their own, so the entry's id is
  // written onto them here. Both lists are then grouped and capped by the same
  // helper the search path uses, so the two surfaces cannot drift apart in how
  // they de-duplicate a sentence that arrives through both attachments.
  const directExampleRows: ExampleRow[] = directRows.map((row) => ({
    headwordId: params.headwordId,
    id: row.id,
    text: row.text,
    languageCode: row.languageCode,
    translationText: row.translationText,
    translationLanguageCode: row.translationLanguageCode,
    sourceSlug: row.sourceSlug,
    attribution: row.attribution,
  }));
  const examplesByHeadword = collectExamples(
    [...junctionRows, ...directExampleRows],
    EXAMPLE_LIMIT,
  );
  return {
    headwordId: headword.headwordId,
    lemma: headword.lemma,
    pos: headword.pos,
    languageCode: headword.languageCode,
    senses: senseIds.map((senseId) => ({
      senseId,
      glosses: glossesBySense.get(senseId) ?? [],
      translations: translationsBySense.get(senseId) ?? [],
    })),
    examples: examplesByHeadword.get(params.headwordId) ?? [],
  };
}
