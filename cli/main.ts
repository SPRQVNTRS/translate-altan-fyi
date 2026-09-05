/**
 * translate-altan-fyi CLI, the body.
 *
 * This module is deliberately NOT the entrypoint. `cli/index.ts` is, and it
 * exists only so that `CLI_MODE` and `LOG_LEVEL` are set before this module,
 * and the whole import graph hanging off it, is evaluated. Read the comment
 * there before moving anything back.
 */

import 'dotenv/config';
import { Command } from 'commander';
import { closePool } from '#drizzle/db';
import { setColorsEnabled, printError } from './lib/output';
import { CliApiError, CliAuthError, DirectTransport, createTransport, setTransport } from './lib/transport';
import { registerDirectTransportHandlers } from './lib/direct-transport-handlers';

// Import command registrations
import { registerAccountCommands } from './commands/account';
import { registerDbCommands } from './commands/db';
import { registerApiKeyCommands } from './commands/api-key';
import { registerDataMigrationCommands } from './commands/data-migration/run';
import { registerImportCommands } from './commands/import/index';
import { registerDictionaryCommands } from './commands/dictionary';
import { registerTranslationCommands } from './commands/translation';
import { registerTranslateCommand } from './commands/translate';

interface GlobalCliOptions {
  color?: boolean;
  remote?: string;
  prod?: boolean;
  token?: string;
}

function resolveTransportOptions(opts: GlobalCliOptions) {
  let remote = opts.remote;
  if (opts.prod) {
    const prodUrl = process.env.TRANSLATE_PROD_URL;
    if (!prodUrl) {
      throw new CliApiError(
        '--prod requires TRANSLATE_PROD_URL env var to be set',
        0,
      );
    }
    remote = prodUrl;
  }
  const token = opts.token ?? process.env.TRANSLATE_API_KEY;
  return { remote, token };
}

async function main(): Promise<void> {
  const program = new Command();

  program
    .name('translate-cli')
    .description('translate-altan-fyi CLI, manage accounts, the dictionary, API keys and the database')
    .version('1.0.0')
    .enablePositionalOptions()
    .option('--no-color', 'Disable colored output')
    .option(
      '--remote <url>',
      'Base URL of the target server (routes commands through the HTTP API instead of direct DB)',
    )
    .option('--prod', 'Shorthand for --remote=$TRANSLATE_PROD_URL')
    .option('--token <key>', 'API key (overrides TRANSLATE_API_KEY env var)')
    .hook('preAction', (thisCommand) => {
      const opts = thisCommand.opts<GlobalCliOptions>();
      if (opts.color === false) {
        setColorsEnabled(false);
      }
      // Resolve transport from global flags + env. preAction runs after
      // commander has parsed argv but before the subcommand's action,
      // so subcommands see the configured transport when they read the
      // live-binding singleton.
      const { remote, token } = resolveTransportOptions(opts);
      const t = createTransport({ remote, token });
      setTransport(t);
      // Register in-process DirectTransport handlers when not using HTTP.
      // This runs once per CLI invocation (preAction fires once before parseAsync).
      if (t instanceof DirectTransport) {
        registerDirectTransportHandlers(t);
      }
    });

  // Register all command groups
  registerAccountCommands(program);
  registerDbCommands(program);
  registerApiKeyCommands(program);
  registerDataMigrationCommands(program);
  registerImportCommands(program);
  registerDictionaryCommands(program);
  registerTranslationCommands(program);
  registerTranslateCommand(program);

  await program.parseAsync(process.argv);
}

function handleCliError(cause: unknown): number {
  if (cause instanceof CliAuthError) {
    printError(`invalid or missing API key: ${cause.message}`);
    return 2;
  }
  if (cause instanceof CliApiError) {
    printError(cause.message);
    return 1;
  }
  if (cause instanceof Error) {
    printError(cause.message);
    return 1;
  }
  printError(String(cause));
  return 1;
}

/**
 * Run one CLI invocation to completion, including error mapping and pool
 * teardown. Never rejects; a failure is reported through `process.exitCode`.
 */
export async function runCli(): Promise<void> {
  try {
    await main();
  } catch (cause: unknown) {
    process.exitCode = handleCliError(cause);
  } finally {
    // Must be closePool(), not pool.end(). In production the pool also starts a
    // stats timer, which pool.end() leaves running, so the CLI never exits.
    // scripts/start.sh then parks on this process forever and never reaches
    // `exec pnpm start`, so the server never listens and the container 502s.
    await closePool();
  }
}
