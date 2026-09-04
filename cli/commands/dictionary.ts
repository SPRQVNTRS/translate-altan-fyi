/**
 * `pnpm cli dictionary stats`, count the rows in the shared dictionary zone.
 *
 * WHY THIS COMMAND READS POSTGRES DIRECTLY
 *   ADR-0001 says the CLI wraps the HTTP API, and keeps a short list of
 *   exceptions. Its amendment of 2026-09-02 admits the dictionary importers.
 *   `dictionary stats` belongs with them, for three reasons.
 *
 *   It is the import's verification counterpart. An import is an offline
 *   operator action against a local dump, run with no server up. A check that
 *   could only be reached through the HTTP API would be unable to check the
 *   thing that just happened, because the thing that just happened was done
 *   with the web application stopped.
 *
 *   It reads the SHARED dictionary. Every table counted below describes the
 *   one dictionary this installation serves, so there is nothing here that one
 *   reader may see and another may not.
 *
 *   It is read-only and aggregate. It emits row counts and the provenance rows
 *   themselves, which are licence metadata. It exposes no per-user and no
 *   per-tenant data.
 *
 *   THIS IS NOT A DOOR TO SERVING DICTIONARY CONTENT FROM THE CLI. Reading
 *   dictionary rows to show a user still goes through the API path, where the
 *   licence allowlist is applied in SQL. The exception here is counting, not
 *   reading.
 */

import { Command } from 'commander';
import { count, eq } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { PgTable } from 'drizzle-orm/pg-core';
import type * as schema from '#drizzle/schema';
import {
  exampleHeadwords,
  examples,
  headwordLinks,
  headwords,
  languages,
  senseVersions,
  senses,
  sources,
  translations,
} from '#drizzle/schema';
import { getRawDb } from '#drizzle/db';
import { createTable, formatDate, outputJson, printSection } from '../lib/output';
import type { TableColumn } from '../lib/types';

/** The database handle. Typed like `cli/lib/importers/upsert.ts`, for the same reason. */
type DictionaryDb = NodePgDatabase<typeof schema>;

interface CountSpec {
  /** The Postgres table name, printed verbatim as the label. */
  readonly label: string;
  readonly table: PgTable;
}

interface CountRow {
  readonly label: string;
  readonly total: number;
}

interface SourceRow {
  readonly slug: string;
  readonly licence: string;
  readonly version: string | null;
  readonly importedAt: Date | null;
  readonly headwords: number;
  readonly examples: number;
}

/**
 * Every table in the shared dictionary zone, in the order they are printed.
 * The labels are the Postgres table names, not the Drizzle identifiers, so the
 * output can be compared against `\dt` or against a migration by eye.
 */
const COUNT_TABLES: readonly CountSpec[] = [
  { label: 'sources', table: sources },
  { label: 'languages', table: languages },
  { label: 'headwords', table: headwords },
  { label: 'senses', table: senses },
  { label: 'sense_versions', table: senseVersions },
  { label: 'translations', table: translations },
  { label: 'headword_links', table: headwordLinks },
  { label: 'examples', table: examples },
  { label: 'example_headwords', table: exampleHeadwords },
];

const SOURCE_COLUMNS: TableColumn<SourceRow>[] = [
  { header: 'Slug', key: 'slug' },
  { header: 'Licence', key: 'licence' },
  { header: 'Version', key: (row) => row.version ?? '-' },
  { header: 'Imported', key: (row) => (row.importedAt ? formatDate(row.importedAt) : '-') },
  { header: 'Headwords', key: (row) => String(row.headwords), align: 'right' },
  { header: 'Examples', key: (row) => String(row.examples), align: 'right' },
];

export function registerDictionaryCommands(program: Command): void {
  const dictionaryCmd = program
    .command('dictionary')
    .description('Shared dictionary utilities');

  dictionaryCmd
    .command('stats')
    .description('Count the rows in the shared dictionary tables, per table and per source')
    .option('--json', 'Output as JSON', false)
    .action(async (options: { json: boolean }) => {
      await showStats(options);
    });
}

// ---------------------------------------------------------------------------
// Command implementations
// ---------------------------------------------------------------------------

async function showStats(options: { json: boolean }): Promise<void> {
  // The dictionary tables are global and carry no organization id, so the raw
  // handle is the correct one. This is the pool the CLI already opened; the
  // entrypoint closes it in its `finally`.
  const db = getRawDb();

  const [countRows, sourceRows] = await Promise.all([countTables(db), listSources(db)]);

  if (options.json) {
    outputJson({
      counts: Object.fromEntries(countRows.map((row) => [row.label, row.total])),
      sources: sourceRows.map((row) => ({
        slug: row.slug,
        licence: row.licence,
        version: row.version,
        importedAt: row.importedAt ? row.importedAt.toISOString() : null,
        headwords: row.headwords,
        examples: row.examples,
      })),
    });
    return;
  }

  printSection('Dictionary Row Counts');
  // THE FORMAT OF THESE LINES IS ASSERTED BY A CHECKLIST GREP.
  // The check matches `/headwords: *[1-9][0-9]*/` against this output, so the
  // label must be the bare lowercase table name, immediately followed by a
  // colon. Do not "improve" this into a box-drawn table, and do not route it
  // through `printField`: that bolds the label, which puts an ANSI reset
  // sequence between the name and the colon and silently breaks the check.
  for (const row of countRows) {
    console.log(`${row.label}: ${row.total}`);
  }

  printSection('Sources');
  console.log(createTable(SOURCE_COLUMNS, sourceRows).toString());
}

/** Count every dictionary table, concurrently. */
async function countTables(db: DictionaryDb): Promise<CountRow[]> {
  return Promise.all(
    COUNT_TABLES.map(async (spec): Promise<CountRow> => {
      const [row] = await db.select({ total: count() }).from(spec.table);
      return { label: spec.label, total: row?.total ?? 0 };
    }),
  );
}

/** Every provenance row, with the content attributed to it. */
async function listSources(db: DictionaryDb): Promise<SourceRow[]> {
  const rows = await db
    .select({
      id: sources.id,
      slug: sources.slug,
      licence: sources.licence,
      version: sources.version,
      importedAt: sources.importedAt,
    })
    .from(sources)
    .orderBy(sources.slug);

  return Promise.all(
    rows.map(async (row): Promise<SourceRow> => {
      const [headwordCount, exampleCount] = await Promise.all([
        countBySource(db, headwords, row.id),
        countBySource(db, examples, row.id),
      ]);
      return {
        slug: row.slug,
        licence: row.licence,
        version: row.version,
        importedAt: row.importedAt,
        headwords: headwordCount,
        examples: exampleCount,
      };
    }),
  );
}

/** Count the rows of one content table attributed to one source. */
async function countBySource(
  db: DictionaryDb,
  table: typeof headwords | typeof examples,
  sourceId: string,
): Promise<number> {
  const [row] = await db
    .select({ total: count() })
    .from(table)
    .where(eq(table.sourceId, sourceId));
  return row?.total ?? 0;
}
