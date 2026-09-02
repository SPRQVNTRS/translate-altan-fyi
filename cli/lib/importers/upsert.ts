/**
 * The write helpers every importer shares.
 *
 * EVERY HELPER HERE IS IDEMPOTENT
 *   A second run of any importer over the same dump must write zero new rows.
 *   That is not a nicety: an import is interrupted by a full disk, a killed
 *   terminal or a truncated archive often enough that "run it again" has to be
 *   the recovery procedure. Every statement below therefore names a conflict
 *   target and says what happens on a hit.
 *
 * THE DATABASE IS A PARAMETER, NEVER AN IMPORT
 *   `drizzle/db.ts` opens a connection pool at module load, so importing it
 *   here would open a pool in every process that so much as touches this file.
 *   The handle arrives as the first argument instead, and the only thing this
 *   module takes from the database layer is a TYPE. Same rule, same reason, as
 *   `app/lib/dictionary/queries.server.ts`.
 */

import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type * as schema from '#drizzle/schema';
import { exampleHeadwords, headwords, sources } from '#drizzle/schema';
import type { InsertExampleHeadword, InsertHeadword } from '#drizzle/schema';
import type { ImporterSource } from './contract';

/** The database handle every helper takes. Type-only, so this module still opens no pool. */
export type ImporterDb = NodePgDatabase<typeof schema>;

/**
 * How many rows go into one INSERT.
 *
 * Postgres accepts at most 65535 bind parameters in a single statement. A
 * headword row costs five of them (language, lemma, normalized lemma, part of
 * speech, source), so an unbounded bulk insert stops working at about 13000
 * rows, and a dump has millions. 1000 rows is 5000 parameters, which leaves
 * room for the widest row any importer writes.
 */
export const INSERT_CHUNK_SIZE = 1000;

export function chunk<T>(rows: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let start = 0; start < rows.length; start += size) {
    chunks.push(rows.slice(start, start + size));
  }
  return chunks;
}

/**
 * Write the provenance row and give back its id.
 *
 * The conflict target is the slug, not the id. The slug is the importer's
 * identity, fixed in its own code and the same on every run; the uuid is
 * assigned by the database the first time and then never reused, because
 * content rows point at it forever.
 */
export async function upsertSource(db: ImporterDb, source: ImporterSource): Promise<string> {
  const [row] = await db
    .insert(sources)
    .values({
      slug: source.slug,
      name: source.name,
      url: source.url,
      licence: source.licence,
      attribution: source.attribution,
      version: source.version,
      importedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: sources.slug,
      set: {
        name: source.name,
        url: source.url,
        licence: source.licence,
        attribution: source.attribution,
        version: source.version,
        importedAt: new Date(),
      },
    })
    .returning({ id: sources.id });

  if (!row) {
    throw new Error(`Failed to upsert source "${source.slug}"`);
  }
  return row.id;
}

/** The natural key of a headword, as one string, so it can key a Map. */
function headwordKey(languageCode: string, lemma: string, pos: string | null | undefined): string {
  return `${languageCode}\t${lemma}\t${pos ?? ''}`;
}

/**
 * Write headwords and give back an id for every one of them.
 *
 * WHY THIS IS `onConflictDoUpdate` AND NOT `onConflictDoNothing`
 *   `DO NOTHING` returns no row for a conflicting insert. On the first run
 *   every row is new, so `RETURNING` gives back everything and the map is
 *   complete. On the second run every row conflicts, `RETURNING` gives back
 *   nothing, and the map comes back empty, so every id the caller needs for its
 *   senses and examples is silently lost. `DO UPDATE` touches the row, which
 *   makes it a returned row, so both the new and the pre-existing ids come
 *   back. The update itself is deliberately close to a no-op: it writes the
 *   normalized lemma back from the excluded row.
 *
 * WHY THE INPUT IS DE-DUPLICATED FIRST
 *   Postgres raises "ON CONFLICT DO UPDATE command cannot affect row a second
 *   time" when one statement carries the same conflict key twice. A dump does
 *   that all the time, because the same lemma appears in many entries, so the
 *   duplicates are removed here before the statement is built.
 */
export async function upsertHeadwords(
  db: ImporterDb,
  rows: InsertHeadword[],
): Promise<Map<string, string>> {
  const ids = new Map<string, string>();
  if (rows.length === 0) return ids;

  const unique = new Map<string, InsertHeadword>();
  for (const row of rows) {
    unique.set(headwordKey(row.languageCode, row.lemma, row.pos), row);
  }

  for (const batch of chunk([...unique.values()], INSERT_CHUNK_SIZE)) {
    const written = await db
      .insert(headwords)
      .values(batch)
      .onConflictDoUpdate({
        target: [headwords.languageCode, headwords.lemma, headwords.pos],
        set: { lemmaNormalized: sql`excluded.lemma_normalized` },
      })
      .returning({
        id: headwords.id,
        languageCode: headwords.languageCode,
        lemma: headwords.lemma,
        pos: headwords.pos,
      });

    for (const row of written) {
      ids.set(headwordKey(row.languageCode, row.lemma, row.pos), row.id);
    }
  }

  return ids;
}

/**
 * Attach examples to headwords, and report how many attachments were new.
 *
 * The composite primary key on (example_id, headword_id) makes this idempotent
 * on its own: a re-run offers the same pairs, they are already there, and
 * `DO NOTHING` writes none of them. The count is what `RETURNING` gave back,
 * so it is the number of rows that really landed, not the number offered.
 */
export async function insertExampleHeadwords(
  db: ImporterDb,
  rows: InsertExampleHeadword[],
): Promise<number> {
  if (rows.length === 0) return 0;

  let written = 0;
  for (const batch of chunk(rows, INSERT_CHUNK_SIZE)) {
    const inserted = await db
      .insert(exampleHeadwords)
      .values(batch)
      .onConflictDoNothing()
      .returning({ exampleId: exampleHeadwords.exampleId });
    written += inserted.length;
  }

  return written;
}
