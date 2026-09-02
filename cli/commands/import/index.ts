/**
 * `pnpm cli import <source>`, load an open-data dictionary dump.
 *
 * WHY THIS IS A CLI COMMAND AND NOT A DATA MIGRATION
 *   The workspace has a data-migrations runner, and it is the wrong home for
 *   this. That runner exists to apply each pending file exactly once, on
 *   container start, right after the schema migrations. Both halves of that
 *   are wrong here.
 *
 *   Once is wrong. An import is re-run on purpose: a new dump is published, a
 *   run is interrupted, a language is added. The helpers in
 *   `cli/lib/importers/upsert.ts` are idempotent precisely so that running the
 *   same import again is safe and cheap.
 *
 *   At boot is wrong. These dumps are hundreds of megabytes and the run takes
 *   minutes to hours. Doing that inside the start path would hold the container
 *   short of listening, and a failed import would turn into a failed deploy of
 *   a service whose dictionary was already fine. It also needs a local file the
 *   operator downloaded, which a container at boot does not have.
 *
 *   So the operator runs it, by hand, when there is a dump to load.
 */

/**
 * WHY THERE ARE TWO IMPORTERS AND NOT THREE
 *   A PanLex importer used to sit between these two. The operator dropped it
 *   because the upstream is gone. `db.panlex.org` and `api.panlex.org` both
 *   answer NXDOMAIN, and `panlex.org/snapshot/` soft-404s to the homepage. The
 *   last Internet Archive capture of that file listing is 2025-11-13. It shows
 *   snapshots up to `panlex-20251101-csv.zip`, but the archive does not hold
 *   the zip files themselves. If the decision is ever revisited, a CC0
 *   third-party mirror named `cointegrated/panlex-meanings` is published on
 *   Hugging Face, derived from the 2024-03-01 snapshot.
 *
 *   The schema keeps `headword_links` and its `panlex-fallback` kind on
 *   purpose. A word-level link is still the right shape for a low confidence
 *   fallback, and a later milestone may fill those rows from another source.
 */

import { Command, Option } from 'commander';
import { printSummary, DEFAULT_LANGUAGES } from '../../lib/importers/contract';
import { wikidataLexemesImporter } from './wikidata-lexemes';
import { tatoebaImporter } from './tatoeba';
import type { TatoebaImportOptions } from './tatoeba';

/** The options every subcommand accepts, as commander hands them over. */
interface SharedCommandOptions {
  file: string;
  languages: string[];
  maxRows?: number;
  dryRun: boolean;
  json: boolean;
}

interface TatoebaCommandOptions extends SharedCommandOptions {
  links: string;
  cc0?: string;
}

const FILE_HELP = 'Path to the local dump. The importer never downloads.';

/**
 * Parse `--languages`.
 *
 * Lowercased, because a language code is compared against `languages.code`,
 * which is stored lowercase, and `--languages EN,DE` should not silently keep
 * nothing.
 */
function parseLanguages(value: string): string[] {
  return value
    .split(',')
    .map((code) => code.trim().toLowerCase())
    .filter((code) => code !== '');
}

/**
 * Parse `--max-rows`.
 *
 * A bad value is rejected here rather than defaulted, because the quiet failure
 * mode is far worse than a stopped command: `--max-rows abc` becoming NaN would
 * read as "no limit" and start a multi-hour run the operator asked to keep short.
 */
function parseMaxRows(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`--max-rows must be a positive whole number, got "${value}"`);
  }
  return parsed;
}

/** Add the options every importer shares. */
function addSharedOptions(command: Command): Command {
  return command
    .addOption(new Option('-f, --file <path>', FILE_HELP).makeOptionMandatory())
    .option(
      '-l, --languages <codes>',
      'Comma separated language codes to keep.',
      parseLanguages,
      [...DEFAULT_LANGUAGES],
    )
    .option('-m, --max-rows <n>', 'Stop after this many source rows.', parseMaxRows)
    .option('--dry-run', 'Parse and count, write nothing.', false)
    .option('--json', 'Print the summary as JSON.', false);
}

export function registerImportCommands(program: Command): void {
  const importCommand = program
    .command('import')
    .description('Import open-data dictionary sources');

  addSharedOptions(
    importCommand
      .command('wikidata-lexemes')
      .description('Import lexemes, senses and glosses from a Wikidata lexeme dump'),
  ).action(async (options: SharedCommandOptions) => {
    const summary = await wikidataLexemesImporter.run({
      file: options.file,
      languages: options.languages,
      maxRows: options.maxRows,
      dryRun: options.dryRun,
    });
    printSummary(wikidataLexemesImporter.source, summary, options.json);
  });

  addSharedOptions(
    importCommand
      .command('tatoeba')
      .description('Import example sentences and their translations from Tatoeba exports'),
  )
    .addOption(new Option('--links <path>', 'Path to links.tar.bz2.').makeOptionMandatory())
    .option(
      '--cc0 <path>',
      'Path to sentences_CC0.tar.bz2. Sentences listed there are recorded under the CC0 source instead of CC BY.',
    )
    .action(async (options: TatoebaCommandOptions) => {
      const tatoebaOptions: TatoebaImportOptions = {
        file: options.file,
        languages: options.languages,
        maxRows: options.maxRows,
        dryRun: options.dryRun,
        links: options.links,
        cc0: options.cc0,
      };
      const summary = await tatoebaImporter.run(tatoebaOptions);
      printSummary(tatoebaImporter.source, summary, options.json);
    });
}
