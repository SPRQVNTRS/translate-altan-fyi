/**
 * Read queries over the shared dictionary.
 *
 * TWO RULES GOVERN EVERY HELPER IN THIS FILE.
 *
 * 1. THE DATABASE IS A PARAMETER, NEVER AN IMPORT.
 *    `drizzle/db.ts` opens a connection pool at module load. Importing it here
 *    would open a pool in every process that touches this module, including the
 *    unit tests and the CLI. So the database arrives as the first argument, and
 *    the only thing this file imports from the database layer is a TYPE.
 *
 * 2. THE LICENCE FILTER LIVES IN THE SQL.
 *    Every query joins `sources` and constrains `sources.licence` with
 *    `inArray(...)` inside the statement. It is never a `.filter()` over the
 *    returned rows. A JavaScript filter is invisible to `toSQL()`, invisible to
 *    anyone reading the query, and absent from any code path that forgets to
 *    apply it. In the SQL it is part of the query itself, it cannot be dropped
 *    by accident, and `tests/unit/dictionary-licences.test.ts` can prove it is
 *    there by inspecting the generated statement.
 */

import { and, eq, inArray, max, type SQL } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type * as schema from '#drizzle/schema';
import {
  entryAliases,
  headwordLinks,
  headwords,
  senseVersions,
  senses,
  sources,
  translations,
} from '#drizzle/schema';
import { SERVED_LICENCES } from './licences';

/**
 * The database handle every helper takes.
 *
 * Type-only: naming the shape of the Drizzle instance costs nothing at runtime,
 * so this module still creates no pool when it is imported.
 */
export type DictionaryDb = NodePgDatabase<typeof schema>;

/** How many headwords a lookup returns when the caller states no limit. */
const DEFAULT_HEADWORD_LIMIT = 20;

/**
 * The licence predicate, as SQL.
 *
 * Spread into a mutable array because `SERVED_LICENCES` is a readonly tuple and
 * `inArray` takes a plain array. The values land in the statement as bound
 * parameters, which is what the SQL-level test asserts on.
 */
function servedLicence(): SQL {
  return inArray(sources.licence, [...SERVED_LICENCES]);
}

// =============================================================================
// Current sense version
// =============================================================================

/**
 * The current version number of every sense, as a joinable subquery.
 *
 * "Current" is DERIVED: it is `max(version)` per sense, computed at read time.
 * There is deliberately no `is_current` flag on `sense_versions`. A boolean
 * flag is a second source of truth that drifts, it has to be un-set on the
 * previous row every time a version is appended, and one missed write leaves
 * either two current rows or none. A max() cannot disagree with the data it is
 * computed from.
 *
 * Returned un-awaited so callers can join it. The return type is Drizzle's
 * generated subquery type, which has no spellable name.
 */
export function currentSenseVersions(db: DictionaryDb) {
  return db
    .select({
      senseId: senseVersions.senseId,
      version: max(senseVersions.version),
    })
    .from(senseVersions)
    .groupBy(senseVersions.senseId)
    .as('current_sense_versions');
}

// =============================================================================
// Headword lookup
// =============================================================================

/** One headword row a lookup may serve, with the provenance it must be shown with. */
export interface HeadwordMatch {
  id: string;
  languageCode: string;
  lemma: string;
  lemmaNormalized: string;
  pos: string | null;
  sourceId: string;
  sourceSlug: string;
  sourceLicence: string;
  attribution: string;
}

export interface FindHeadwordsParams {
  /** Restrict to one language. Omitted means every language. */
  languageCode?: string;
  /** Lowercased, unaccented lemma. Matched exactly. */
  lemmaNormalized: string;
  limit?: number;
}

/**
 * Look up headwords by their normalized lemma.
 *
 * The match is EXACT for now. The trigram index on `lemma_normalized` is in
 * place for the forgiving search that lands in a later spec, but nothing here
 * uses it yet: an exact match is the behaviour we can currently defend, and a
 * half-tuned similarity threshold would be worse than no fuzzy search at all.
 *
 * Returned un-awaited, so a test can read the generated SQL and a caller can
 * simply await it.
 */
export function findHeadwords(db: DictionaryDb, params: FindHeadwordsParams) {
  return db
    .select({
      id: headwords.id,
      languageCode: headwords.languageCode,
      lemma: headwords.lemma,
      lemmaNormalized: headwords.lemmaNormalized,
      pos: headwords.pos,
      sourceId: sources.id,
      sourceSlug: sources.slug,
      sourceLicence: sources.licence,
      attribution: sources.attribution,
    })
    .from(headwords)
    .innerJoin(sources, eq(headwords.sourceId, sources.id))
    .where(
      and(
        eq(headwords.lemmaNormalized, params.lemmaNormalized),
        params.languageCode ? eq(headwords.languageCode, params.languageCode) : undefined,
        servedLicence(),
      ),
    )
    .limit(params.limit ?? DEFAULT_HEADWORD_LIMIT);
}

// =============================================================================
// Translations
// =============================================================================

/** A sense-to-sense translation edge: the result surface we actually serve. */
export interface SenseTranslation {
  translationId: string;
  fromSenseId: string;
  toSenseId: string;
  confidence: number | null;
  sourceSlug: string;
  sourceLicence: string;
  attribution: string;
}

/** A word-to-word edge. Right for one sense of the word and wrong for the others. */
export interface WordLevelLink {
  linkId: string;
  fromHeadwordId: string;
  toHeadwordId: string;
  kind: string;
  score: number | null;
  sourceSlug: string;
  sourceLicence: string;
  attribution: string;
}

/** The two result sets, kept apart on purpose. See `getTranslationsForSense`. */
export interface TranslationsForSense {
  senseLevel: SenseTranslation[];
  wordLevelFallback: (WordLevelLink & { lowConfidence: true })[];
}

/**
 * Sense-level translations leaving one sense, licence-filtered in SQL.
 *
 * Returned un-awaited so the licence test can read the statement.
 */
export function senseTranslationsQuery(db: DictionaryDb, senseId: string) {
  return db
    .select({
      translationId: translations.id,
      fromSenseId: translations.fromSenseId,
      toSenseId: translations.toSenseId,
      confidence: translations.confidence,
      sourceSlug: sources.slug,
      sourceLicence: sources.licence,
      attribution: sources.attribution,
    })
    .from(translations)
    .innerJoin(senses, eq(translations.fromSenseId, senses.id))
    .innerJoin(sources, eq(translations.sourceId, sources.id))
    .where(and(eq(translations.fromSenseId, senseId), servedLicence()));
}

/**
 * Word-level fallback links leaving one headword, licence-filtered in SQL.
 *
 * Returned un-awaited so the licence test can read the statement.
 */
export function headwordFallbackLinksQuery(db: DictionaryDb, headwordId: string) {
  return db
    .select({
      linkId: headwordLinks.id,
      fromHeadwordId: headwordLinks.fromHeadwordId,
      toHeadwordId: headwordLinks.toHeadwordId,
      kind: headwordLinks.kind,
      score: headwordLinks.score,
      sourceSlug: sources.slug,
      sourceLicence: sources.licence,
      attribution: sources.attribution,
    })
    .from(headwordLinks)
    .innerJoin(headwords, eq(headwordLinks.fromHeadwordId, headwords.id))
    .innerJoin(sources, eq(headwordLinks.sourceId, sources.id))
    .where(and(eq(headwordLinks.fromHeadwordId, headwordId), servedLicence()));
}

/**
 * Both result sets for one sense, in two separate fields.
 *
 * THE TWO FIELDS ARE NEVER MERGED.
 *   A sense-level translation is an edge between two MEANINGS: it is correct
 *   for exactly the meaning it was recorded for. A PanLex word-level pair is an
 *   edge between two SPELLINGS: it is right for one sense of the word and wrong
 *   for every other sense of the same word. Concatenating the two arrays would
 *   present a guess with the same authority as a fact, and once merged there is
 *   no way for a caller to tell them apart again.
 *
 *   Every fallback row therefore carries the literal `lowConfidence: true`, so
 *   the marker travels with the row rather than with the variable that happens
 *   to hold it. A renderer must label these, and should show them only when
 *   `senseLevel` is empty.
 */
export async function getTranslationsForSense(
  db: DictionaryDb,
  senseId: string,
  headwordId: string,
): Promise<TranslationsForSense> {
  const [senseLevel, fallbackRows] = await Promise.all([
    senseTranslationsQuery(db, senseId),
    headwordFallbackLinksQuery(db, headwordId),
  ]);

  // Named field by field rather than spread: the marker is part of the row's
  // shape, so it is written where the shape is written.
  const wordLevelFallback: (WordLevelLink & { lowConfidence: true })[] = fallbackRows.map(
    (row) => ({
      linkId: row.linkId,
      fromHeadwordId: row.fromHeadwordId,
      toHeadwordId: row.toHeadwordId,
      kind: row.kind,
      score: row.score,
      sourceSlug: row.sourceSlug,
      sourceLicence: row.sourceLicence,
      attribution: row.attribution,
      lowConfidence: true,
    }),
  );

  return { senseLevel, wordLevelFallback };
}

// =============================================================================
// Entry resolution (live id, retired id, or neither)
// =============================================================================

/** The three kinds of row an id can address. */
export type EntryEntity = 'headword' | 'sense' | 'translation';

/**
 * What an id resolved to.
 *
 * `missing` is a value, not an exception. An unknown id is an ordinary thing
 * for a public URL to contain, and a request that carries one deserves a warm
 * page rather than a stack trace.
 */
export type ResolvedEntry =
  | { kind: 'found'; entity: EntryEntity; id: string }
  | { kind: 'redirect'; replacementId: string }
  | { kind: 'missing' };

/**
 * The two database reads `resolveEntry` needs, as an injectable port.
 *
 * Resolution is decision logic, and decision logic is worth testing without a
 * database. The real implementation is `createEntryLookups`; a test supplies a
 * hand-written object with the same two methods.
 */
export interface EntryLookups {
  findEntity(id: string): Promise<{ entity: EntryEntity; id: string } | null>;
  findAlias(id: string): Promise<{ replacementId: string } | null>;
}

/**
 * Canonical UUID text form.
 *
 * Postgres raises `22P02 invalid input syntax for type uuid` when a malformed
 * id reaches a uuid comparison, which would surface as a 500 for what is really
 * a bad URL. The guard runs before any query so a typo costs no round trip.
 */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The real lookups, licence-filtered in SQL like every other read here. */
export function createEntryLookups(db: DictionaryDb): EntryLookups {
  return {
    async findEntity(id: string): Promise<{ entity: EntryEntity; id: string } | null> {
      const [headwordRows, senseRows, translationRows] = await Promise.all([
        db
          .select({ id: headwords.id })
          .from(headwords)
          .innerJoin(sources, eq(headwords.sourceId, sources.id))
          .where(and(eq(headwords.id, id), servedLicence()))
          .limit(1),
        db
          .select({ id: senses.id })
          .from(senses)
          .innerJoin(sources, eq(senses.sourceId, sources.id))
          .where(and(eq(senses.id, id), servedLicence()))
          .limit(1),
        db
          .select({ id: translations.id })
          .from(translations)
          .innerJoin(sources, eq(translations.sourceId, sources.id))
          .where(and(eq(translations.id, id), servedLicence()))
          .limit(1),
      ]);

      const headwordRow = headwordRows[0];
      if (headwordRow) return { entity: 'headword', id: headwordRow.id };
      const senseRow = senseRows[0];
      if (senseRow) return { entity: 'sense', id: senseRow.id };
      const translationRow = translationRows[0];
      if (translationRow) return { entity: 'translation', id: translationRow.id };
      return null;
    },

    async findAlias(id: string): Promise<{ replacementId: string } | null> {
      const rows = await db
        .select({ replacementId: entryAliases.replacementId })
        .from(entryAliases)
        .where(eq(entryAliases.retiredId, id))
        .limit(1);
      const row = rows[0];
      return row ? { replacementId: row.replacementId } : null;
    },
  };
}

/**
 * Resolve a published id to a live entity, a redirect, or nothing.
 *
 * NEVER THROWS. Unknown, retired, and malformed ids are all ordinary inputs on
 * a public URL, so each one is a returned value the caller can render.
 *
 * EXACTLY ONE ALIAS HOP.
 *   If the replacement is itself retired, this still returns the FIRST
 *   replacement. Following the chain would mean looping over data this code
 *   does not control: `a -> b -> a` is a hang, not an error, and it would hang
 *   inside a request handler holding a database connection. One hop is bounded
 *   by construction. A replacement that is itself retired is a data problem to
 *   repair in `entry_aliases`, by repointing the older alias at the final id.
 */
export async function resolveEntry(lookups: EntryLookups, id: string): Promise<ResolvedEntry> {
  if (!UUID_PATTERN.test(id)) return { kind: 'missing' };

  const entity = await lookups.findEntity(id);
  if (entity) return { kind: 'found', entity: entity.entity, id: entity.id };

  const alias = await lookups.findAlias(id);
  if (alias) return { kind: 'redirect', replacementId: alias.replacementId };

  return { kind: 'missing' };
}
