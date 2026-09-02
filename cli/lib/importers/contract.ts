/**
 * The one shape every dictionary importer shares.
 *
 * WHY DROPS ARE COUNTED AND NOT LOGGED
 *   A dump of open data is mostly rows we do not want. The Wikidata lexeme dump
 *   carries about 1.6 million lexemes and we keep four languages, so the great
 *   majority of every run is a drop. A line of log per dropped row produces
 *   millions of lines, which nobody reads, which fills a terminal buffer, and
 *   which slows the run down by more than the parsing does.
 *
 *   What an operator actually wants to know is the SHAPE of the loss: how many
 *   rows fell out because of the language filter, how many because the sense
 *   had no gloss, how many because the line would not parse. That is a count
 *   per reason, and it fits on one screen. So an importer names a reason and
 *   increments it, and the summary prints the totals at the end.
 *
 *   The reason strings are free-form on purpose. Each importer knows its own
 *   dump and names its own reasons, and a shared enum would only force three
 *   different sources into one vocabulary that fits none of them.
 */

import { createTable, printField } from '../output';
import type { TableColumn } from '../types';

/** The provenance row an importer writes before it writes anything else. */
export interface ImporterSource {
  slug: string;
  name: string;
  url: string;
  licence: string;
  attribution: string;
  version: string;
}

/** Why a row was not written. Free-form on purpose: each importer names its own reasons. */
export type DropReason = string;

export interface ImportSummary {
  read: number;
  written: number;
  dropped: Record<DropReason, number>;
  durationMs: number;
}

export interface ImportOptions {
  /** Path to a local dump. Importers NEVER download. */
  file: string;
  /** Language codes to keep. Anything else is a hard drop. */
  languages: string[];
  /** Stop after this many source rows. Undefined means the whole dump. */
  maxRows?: number;
  /** Parse and count, write nothing. */
  dryRun: boolean;
}

export interface Importer<TOptions extends ImportOptions = ImportOptions> {
  source: ImporterSource;
  run(options: TOptions): Promise<ImportSummary>;
}

/** The four languages the dictionary serves. Every importer keeps these unless told otherwise. */
export const DEFAULT_LANGUAGES = ['en', 'de', 'tr', 'es'] as const;

/**
 * A tally of drop reasons.
 *
 * It exists so that no importer has to hand-roll the same
 * `counts[reason] = (counts[reason] ?? 0) + 1` line, which is easy to get
 * subtly wrong and impossible to read in the middle of a parse loop.
 */
export interface DropCounter {
  drop(reason: string): void;
  count(): Record<string, number>;
}

export function createDropCounter(): DropCounter {
  // A Map, not a plain object, because reason strings come from importer code
  // and a Map has no prototype keys to collide with.
  const counts = new Map<string, number>();

  return {
    drop(reason: string): void {
      counts.set(reason, (counts.get(reason) ?? 0) + 1);
    },
    count(): Record<string, number> {
      return Object.fromEntries(counts);
    },
  };
}

/** One line of the printed summary table. */
interface SummaryRow {
  metric: string;
  value: string;
}

const summaryColumns: TableColumn<SummaryRow>[] = [
  { header: 'Metric', key: 'metric' },
  { header: 'Value', key: 'value', align: 'right' },
];

function totalDropped(dropped: Record<DropReason, number>): number {
  let total = 0;
  for (const value of Object.values(dropped)) {
    total += value;
  }
  return total;
}

function summaryRows(summary: ImportSummary): SummaryRow[] {
  const rows: SummaryRow[] = [
    { metric: 'read', value: String(summary.read) },
    { metric: 'written', value: String(summary.written) },
    { metric: 'duration', value: `${summary.durationMs} ms` },
  ];

  // Reasons are listed in the order the importer first reported them, because
  // that is usually the order of the parse pipeline and reads as a funnel.
  for (const [reason, count] of Object.entries(summary.dropped)) {
    rows.push({ metric: `dropped: ${reason}`, value: String(count) });
  }

  rows.push({ metric: 'dropped: total', value: String(totalDropped(summary.dropped)) });
  return rows;
}

/**
 * Print the result of a run.
 *
 * The licence is printed on every run, not just on request. An import that does
 * not say under which licence the rows arrived is an import nobody can audit
 * later, and the whole dictionary rests on that field being right.
 */
export function printSummary(source: ImporterSource, summary: ImportSummary, json: boolean): void {
  if (json) {
    console.log(
      JSON.stringify({ source: source.slug, licence: source.licence, ...summary }, null, 2),
    );
    return;
  }

  printField('Source', source.slug);
  printField('Licence', source.licence);
  printField('Version', source.version);
  console.log(createTable(summaryColumns, summaryRows(summary)).toString());
}
