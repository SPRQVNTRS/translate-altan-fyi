/**
 * `pnpm cli translation runs` and `pnpm cli translation retract <runId>`, the
 * operator's view of the generated corpus and the way to take a run back.
 *
 * WHY THIS COMMAND READS AND WRITES POSTGRES DIRECTLY
 *   ADR-0001 says the CLI wraps the HTTP API and keeps a short list of
 *   exceptions. This belongs with the dictionary importers and `dictionary
 *   stats`, for the same reasons: it operates on the SHARED dictionary, where
 *   nothing is one reader's and another's, and it is the counterpart of an
 *   offline write. A retraction is also exactly the operation an operator needs
 *   when the web application is the thing behaving badly.
 *
 * WHY RETRACTION EXISTS AT ALL
 *   Generated rows are permanent by default and sit in the same four tables as
 *   imported ones. "Permanent" is a policy, not a physical property, and a
 *   policy with no escape hatch is one bad prompt version away from a dictionary
 *   nobody can clean. The run row lists every id it inserted, so a retraction is
 *   an exact operation rather than a guess: it deletes those rows and nothing
 *   else.
 *
 * IT NEVER DELETES A ROW SOMETHING ELSE IS USING
 *   A generated sense that has since acquired an enrichment, an example or an
 *   incoming translation from another run is KEPT, and so is the headword above
 *   it. Every skip is printed, because a retraction that silently left rows
 *   behind would read as a clean removal and would not be one.
 */

import { Command } from 'commander';
import { and, inArray, or, sql } from 'drizzle-orm';

import { getRawDb } from '#drizzle/db';
import {
  enrichments,
  examples,
  exampleHeadwords,
  headwordLinks,
  headwords,
  reenrichmentLog,
  senseVersions,
  senses,
  translationRuns,
  translations,
} from '#drizzle/schema';
import {
  getRun,
  listRuns,
  markRetracted,
  writtenRowIds,
  type TranslationRunView,
} from '#app/models/translation-runs.server';
import type { DictionaryDb } from '#app/lib/dictionary/queries.server';
import { createTable, formatDate, outputJson, printError, printInfo, printSection, printSuccess } from '../lib/output';
import type { TableColumn } from '../lib/types';

/** How many runs `translation runs` prints when the operator states no number. */
const DEFAULT_RUN_LIMIT = 20;

/** One row of the `translation runs` table. */
interface RunListRow {
  readonly id: string;
  readonly headwordId: string;
  readonly pair: string;
  readonly status: string;
  readonly model: string;
  readonly costUsd: string;
  readonly rows: string;
  readonly createdAt: Date;
  readonly retracted: string;
}

const RUN_COLUMNS: TableColumn<RunListRow>[] = [
  { header: 'Run', key: 'id' },
  { header: 'Headword', key: 'headwordId' },
  { header: 'Pair', key: 'pair' },
  { header: 'Status', key: 'status' },
  { header: 'Model', key: 'model' },
  { header: 'Cost', key: 'costUsd', align: 'right' },
  { header: 'Rows', key: 'rows', align: 'right' },
  { header: 'Started', key: (row) => formatDate(row.createdAt) },
  { header: 'Retracted', key: 'retracted' },
];

/** How many dictionary rows one run inserted, as one number for the table. */
function countWritten(run: TranslationRunView): number {
  const written = writtenRowIds(run);
  return written.headwords.length + written.senses.length + written.senseVersions.length + written.translations.length;
}

function toListRow(run: TranslationRunView): RunListRow {
  return {
    id: run.id,
    headwordId: run.headwordId,
    pair: `${run.from} to ${run.to}`,
    status: run.status,
    model: run.model,
    costUsd: run.costUsd === null ? '-' : run.costUsd.toFixed(6),
    rows: String(countWritten(run)),
    createdAt: run.createdAt,
    retracted: run.retractedAt === null ? '-' : formatDate(run.retractedAt),
  };
}

export function registerTranslationCommands(program: Command): void {
  const translation = program.command('translation').description('Generated translations: the runs and their rows');

  translation
    .command('runs')
    .description('List the most recent translation runs, newest first')
    .option('--limit <n>', 'How many runs to show', String(DEFAULT_RUN_LIMIT))
    .option('--json', 'Output as JSON', false)
    .action(async (options: { limit: string; json: boolean }) => {
      await runsCmd(options);
    });

  translation
    .command('retract <runId>')
    .description('Delete the dictionary rows one run created, skipping any row still in use')
    .option('--json', 'Output as JSON', false)
    .action(async (runId: string, options: { json: boolean }) => {
      await retractCmd(runId, options);
    });
}

// ---------------------------------------------------------------------------
// runs
// ---------------------------------------------------------------------------

async function runsCmd(options: { limit: string; json: boolean }): Promise<void> {
  const limit = Number.parseInt(options.limit, 10);
  if (!Number.isInteger(limit) || limit < 1) {
    printError(`--limit must be a positive whole number, got "${options.limit}"`);
    process.exitCode = 1;
    return;
  }

  const db = getRawDb();
  const runs = await listRuns(db, limit);

  if (options.json) {
    outputJson(runs.map((run) => ({ ...run, written: writtenRowIds(run) })));
    return;
  }

  printSection(`Translation runs (${runs.length})`);
  if (runs.length === 0) {
    printInfo('No translation runs yet.');
    return;
  }
  console.log(createTable(RUN_COLUMNS, runs.map(toListRow)).toString());
}

// ---------------------------------------------------------------------------
// retract
// ---------------------------------------------------------------------------

/** What a retraction did, per table. */
export interface RetractionReport {
  removed: { headwords: number; senses: number; senseVersions: number; translations: number };
  kept: { headwords: string[]; senses: string[]; senseVersions: string[] };
}

/**
 * The sense ids, out of `candidates`, that nothing else points at any more.
 *
 * Checked AFTER the run's own translation edges are gone, so an edge this run
 * created does not count as a reason to keep the sense it created. Everything
 * else does: an edge from another run or an import, an enrichment written
 * against the sense, an example attached to it.
 */
async function deletableSenses(db: DictionaryDb, candidates: string[]): Promise<Set<string>> {
  if (candidates.length === 0) return new Set();
  const deletable = new Set(candidates);

  const edges = await db
    .select({ from: translations.fromSenseId, to: translations.toSenseId })
    .from(translations)
    .where(or(inArray(translations.fromSenseId, candidates), inArray(translations.toSenseId, candidates)));
  for (const edge of edges) {
    deletable.delete(edge.from);
    deletable.delete(edge.to);
  }

  const enriched = await db
    .select({ senseId: enrichments.senseId })
    .from(enrichments)
    .where(inArray(enrichments.senseId, candidates));
  for (const row of enriched) deletable.delete(row.senseId);

  const attached = await db
    .select({ senseId: examples.senseId })
    .from(examples)
    .where(inArray(examples.senseId, candidates));
  for (const row of attached) {
    if (row.senseId !== null) deletable.delete(row.senseId);
  }

  return deletable;
}

/**
 * The headword ids, out of `candidates`, that nothing else points at any more.
 *
 * A headword with any sense left under it is kept, whoever wrote that sense.
 * `translation_runs` is checked too: a run row points at the headword it was
 * about, and this retraction deliberately leaves run rows in place, so deleting
 * a headword some other run names would break that foreign key.
 */
async function deletableHeadwords(db: DictionaryDb, candidates: string[]): Promise<Set<string>> {
  if (candidates.length === 0) return new Set();
  const deletable = new Set(candidates);

  const remaining = await db
    .select({ headwordId: senses.headwordId })
    .from(senses)
    .where(inArray(senses.headwordId, candidates));
  for (const row of remaining) deletable.delete(row.headwordId);

  const runRows = await db
    .select({ headwordId: translationRuns.headwordId })
    .from(translationRuns)
    .where(inArray(translationRuns.headwordId, candidates));
  for (const row of runRows) deletable.delete(row.headwordId);

  const links = await db
    .select({ from: headwordLinks.fromHeadwordId, to: headwordLinks.toHeadwordId })
    .from(headwordLinks)
    .where(or(inArray(headwordLinks.fromHeadwordId, candidates), inArray(headwordLinks.toHeadwordId, candidates)));
  for (const row of links) {
    deletable.delete(row.from);
    deletable.delete(row.to);
  }

  const direct = await db
    .select({ headwordId: examples.headwordId })
    .from(examples)
    .where(inArray(examples.headwordId, candidates));
  for (const row of direct) {
    if (row.headwordId !== null) deletable.delete(row.headwordId);
  }

  const junction = await db
    .select({ headwordId: exampleHeadwords.headwordId })
    .from(exampleHeadwords)
    .where(inArray(exampleHeadwords.headwordId, candidates));
  for (const row of junction) deletable.delete(row.headwordId);

  const enrichmentRows = await db
    .select({ headwordId: enrichments.headwordId })
    .from(enrichments)
    .where(inArray(enrichments.headwordId, candidates));
  for (const row of enrichmentRows) deletable.delete(row.headwordId);

  const cooldowns = await db
    .select({ headwordId: reenrichmentLog.headwordId })
    .from(reenrichmentLog)
    .where(inArray(reenrichmentLog.headwordId, candidates));
  for (const row of cooldowns) deletable.delete(row.headwordId);

  return deletable;
}

/**
 * Delete one run's rows, in foreign-key-safe order, inside one transaction.
 *
 * The order is forced by the references: an edge points at two senses, a version
 * points at a sense, a sense points at a headword. Anything else rolls back at
 * the first constraint.
 *
 * ONE TRANSACTION, so a retraction that trips over a reference it did not expect
 * leaves the dictionary exactly as it was rather than half cleared.
 *
 * EXPORTED FOR THE INTEGRATION TIER. What this function decides, which row goes
 * and which row stays, is the whole feature; driving it through commander's argv
 * parsing would test the argument parser instead.
 */
export async function retractRows(db: DictionaryDb, run: TranslationRunView): Promise<RetractionReport> {
  const written = writtenRowIds(run);
  const report: RetractionReport = {
    removed: { headwords: 0, senses: 0, senseVersions: 0, translations: 0 },
    kept: { headwords: [], senses: [], senseVersions: [] },
  };

  await db.transaction(async (tx) => {
    if (written.translations.length > 0) {
      const gone = await tx
        .delete(translations)
        .where(inArray(translations.id, written.translations))
        .returning({ id: translations.id });
      report.removed.translations = gone.length;
    }

    const senseIds = await deletableSenses(tx, written.senses);
    report.kept.senses = written.senses.filter((id) => !senseIds.has(id));

    // A version is only removed with the sense it describes. Removing it from a
    // sense that survives would leave a sense with no wording at all, which
    // renders as an empty meaning rather than as a removed one.
    const versionsToRemove: string[] = [];
    if (written.senseVersions.length > 0) {
      const owners = await tx
        .select({ id: senseVersions.id, senseId: senseVersions.senseId })
        .from(senseVersions)
        .where(inArray(senseVersions.id, written.senseVersions));
      for (const row of owners) {
        if (senseIds.has(row.senseId)) versionsToRemove.push(row.id);
        else report.kept.senseVersions.push(row.id);
      }
    }

    if (versionsToRemove.length > 0) {
      const gone = await tx
        .delete(senseVersions)
        .where(inArray(senseVersions.id, versionsToRemove))
        .returning({ id: senseVersions.id });
      report.removed.senseVersions = gone.length;
    }

    if (senseIds.size > 0) {
      // Re-checked inside the same statement: a sense that acquired a version
      // from somewhere else between the two reads must not be deleted, and this
      // is the only place that can be sure of it.
      const gone = await tx
        .delete(senses)
        .where(
          and(
            inArray(senses.id, [...senseIds]),
            sql`not exists (select 1 from ${senseVersions} where ${senseVersions.senseId} = ${senses.id})`,
          ),
        )
        .returning({ id: senses.id });
      report.removed.senses = gone.length;
      const removed = new Set(gone.map((row) => row.id));
      for (const id of senseIds) {
        if (!removed.has(id)) report.kept.senses.push(id);
      }
    }

    const headwordIds = await deletableHeadwords(tx, written.headwords);
    report.kept.headwords = written.headwords.filter((id) => !headwordIds.has(id));
    if (headwordIds.size > 0) {
      const gone = await tx
        .delete(headwords)
        .where(inArray(headwords.id, [...headwordIds]))
        .returning({ id: headwords.id });
      report.removed.headwords = gone.length;
    }

    await markRetracted(tx, run.id);
  });

  return report;
}

async function retractCmd(runId: string, options: { json: boolean }): Promise<void> {
  const db = getRawDb();
  const run = await getRun(db, runId);
  if (run === null) {
    printError(`No translation run ${runId}`);
    process.exitCode = 1;
    return;
  }

  const report = await retractRows(db, run);

  if (options.json) {
    outputJson([{ runId: run.id, ...report }]);
    return;
  }

  printSection(`Retracted run ${run.id}`);
  printSuccess(
    `Removed ${report.removed.translations} translation(s), ${report.removed.senseVersions} sense version(s), ` +
      `${report.removed.senses} sense(s), ${report.removed.headwords} headword(s)`,
  );
  const keptTotal = report.kept.headwords.length + report.kept.senses.length + report.kept.senseVersions.length;
  if (keptTotal === 0) {
    printInfo('Nothing was kept: every row this run created was still its own.');
    return;
  }
  printInfo(
    `Kept ${report.kept.headwords.length} headword(s), ${report.kept.senses.length} sense(s) and ` +
      `${report.kept.senseVersions.length} sense version(s) that something else still points at.`,
  );
  for (const id of report.kept.headwords) printInfo(`  headword ${id}`);
  for (const id of report.kept.senses) printInfo(`  sense ${id}`);
  for (const id of report.kept.senseVersions) printInfo(`  sense version ${id}`);
}
