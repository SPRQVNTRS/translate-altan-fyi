/**
 * `pnpm cli translate <text> --from <lang> --to <lang>`, the product's own verb.
 *
 * A TOP-LEVEL COMMAND, NOT A SUBCOMMAND OF `translation`. Translating is what
 * this application is for, and burying the verb under a noun is how nobody finds
 * it. `translation runs`, `translation votes` and `translation retract` stay
 * where they are: those are the operator's view of what translating produced.
 *
 * ONE COMMAND FOR A WORD AND FOR A SENTENCE. Nothing here decides which one the
 * text is, and nothing here may: the endpoint asks `normalizeQuery(q, from).isPhrase`,
 * the same call the search screen makes. A `--phrase` flag would be a second
 * opinion, and the one that disagreed would be this one.
 *
 * IT GOES THROUGH THE TRANSPORT, so `--remote` and the default in-process mode
 * run the same server code (ADR-0001). What this file owns is argument parsing
 * and printing, and nothing else.
 */

import { Command } from 'commander';

import { SERVED_LANGUAGES } from '#app/lib/dictionary/detect-language';
import { createTable, outputJson, printError, printInfo, printSection } from '../lib/output';
import { translateAnswerSchema, type TranslateAnswerResponse } from '../lib/schemas';
import { transport } from '../lib/transport';
import type { OutputFormat, TableColumn } from '../lib/types';

/** One printed line of an answer. */
interface AnswerRow {
  readonly translation: string;
  readonly pos: string;
  readonly generated: string;
  readonly votes: string;
}

const ANSWER_COLUMNS: TableColumn<AnswerRow>[] = [
  { header: 'Translation', key: 'translation' },
  { header: 'POS', key: 'pos' },
  { header: 'Generated', key: 'generated' },
  { header: 'Votes', key: 'votes' },
];

/** What each non-ready state means, in one operator-facing line. */
const STATE_NOTES = {
  translating: 'A run is open. Ask again in a moment, or drop --no-wait.',
  'no-entry': 'No dictionary entry matched this word.',
  none: 'Nothing has been recorded for this pair yet.',
} as const;

/** What each refusal means. The four are kept apart because an operator can act on the difference. */
const REFUSAL_NOTES = {
  'rate-limited': 'Refused by the per-caller rate limit.',
  budget: "Refused by the installation's daily budget.",
  'daily-cap': 'Refused by the per-day cap on runs.',
  'too-long': 'Refused: the text is longer than the cap.',
} as const;

export function registerTranslateCommand(program: Command): void {
  program
    .command('translate <text>')
    .description('Translate a word or a sentence, the same way the screen does')
    .requiredOption('--from <lang>', `Source language: ${SERVED_LANGUAGES.join(', ')}`)
    .requiredOption('--to <lang>', `Target language: ${SERVED_LANGUAGES.join(', ')}`)
    .option('--no-wait', 'Answer with whatever is true now, without waiting for a running job')
    .option('-f, --format <format>', 'Output format: table, json', 'table')
    .action(async (text: string, options: { from: string; to: string; wait: boolean; format: OutputFormat }) => {
      await translateCmd(text, options);
    });
}

/** Whether a value names a language this installation serves. */
function isServed(value: string): boolean {
  return SERVED_LANGUAGES.some((code) => code === value);
}

async function translateCmd(
  text: string,
  options: { from: string; to: string; wait: boolean; format: OutputFormat },
): Promise<void> {
  for (const [flag, value] of [
    ['--from', options.from],
    ['--to', options.to],
  ] as const) {
    if (!isServed(value)) {
      printError(`${flag} must be one of ${SERVED_LANGUAGES.join(', ')}, got "${value}"`);
      process.exitCode = 1;
      return;
    }
  }

  if (options.from === options.to) {
    printError('--from and --to must be different languages');
    process.exitCode = 1;
    return;
  }

  const answer = await transport.post('/api/v1/translate', translateAnswerSchema, {
    q: text,
    from: options.from,
    to: options.to,
    wait: options.wait,
  });

  if (options.format === 'json') {
    outputJson([answer]);
    return;
  }

  printAnswer(answer);
}

/**
 * Print one answer.
 *
 * THE HEADING IS THE SAME FOR BOTH BRANCHES, and the branch is one word inside
 * it rather than a different layout. An operator reading two runs side by side
 * has to be able to compare them.
 */
function printAnswer(answer: TranslateAnswerResponse): void {
  printSection(`${answer.q}  (${answer.from} to ${answer.to}, ${answer.kind})`);

  if (answer.panel.state === 'ready') {
    const rows = answer.panel.translations.map(
      (row): AnswerRow => ({
        translation: row.lemma,
        pos: row.pos ?? '-',
        generated: row.generated ? 'yes' : 'no',
        votes: `+${row.up} / -${row.down}`,
      }),
    );
    console.log(createTable(ANSWER_COLUMNS, rows).toString());
    return;
  }

  if (answer.panel.state === 'failed') {
    printError(`The run failed: ${answer.panel.error ?? 'no reason recorded'}`);
    process.exitCode = 1;
    return;
  }

  if (answer.panel.state === 'budget') {
    printInfo(REFUSAL_NOTES[answer.panel.reason]);
    return;
  }

  printInfo(STATE_NOTES[answer.panel.state]);
}
