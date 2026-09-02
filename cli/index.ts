#!/usr/bin/env node
/**
 * translate-altan-fyi CLI
 *
 * A Laravel-style CLI for managing users, organizations, workflows, and database.
 *
 * Usage:
 *   pnpm cli --help
 *   pnpm cli user list
 *   pnpm cli workflow list --status=failed
 *   TRANSLATE_API_KEY=<key> pnpm cli --remote=http://localhost:3000 api-key list --org=default
 */

// Suppress verbose logging BEFORE any imports
process.env.CLI_MODE = 'true';
process.env.LOG_LEVEL = 'error';

import 'dotenv/config';
import { Command } from 'commander';
import { closePool } from '#drizzle/db';
import { setColorsEnabled, printError } from './lib/output';
import { CliApiError, CliAuthError, DirectTransport, createTransport, setTransport } from './lib/transport';
import { registerDirectTransportHandlers } from './lib/direct-transport-handlers';

// Import command registrations
import { registerUserCommands } from './commands/user';
import { registerAccountCommands } from './commands/account';
import { registerOrganizationCommands } from './commands/organization';
import { registerWorkflowCommands } from './commands/workflow';
import { registerOperationCommands } from './commands/operation';
import { registerDbCommands } from './commands/db';
import { registerMetricEventCommands } from './commands/metric-event';
import { registerApiKeyCommands } from './commands/api-key';
import { registerDataSourceCommands } from './commands/data-source';
import { registerDataMigrationCommands } from './commands/data-migration/run';
import { registerImportCommands } from './commands/import/index';
import { registerDictionaryCommands } from './commands/dictionary';

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
    .description('translate-altan-fyi CLI, manage users, organizations, workflows, and database')
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
  registerUserCommands(program);
  registerAccountCommands(program);
  registerOrganizationCommands(program);
  registerWorkflowCommands(program);
  registerOperationCommands(program);
  registerDbCommands(program);
  registerMetricEventCommands(program);
  registerApiKeyCommands(program);
  registerDataSourceCommands(program);
  registerDataMigrationCommands(program);
  registerImportCommands(program);
  registerDictionaryCommands(program);

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

main()
  .catch((cause: unknown) => {
    process.exitCode = handleCliError(cause);
  })
  .finally(async () => {
    // Must be closePool(), not pool.end(). In production the pool also starts a
    // stats timer, which pool.end() leaves running, so the CLI never exits.
    // scripts/start.sh then parks on this process forever and never reaches
    // `exec pnpm start`, so the server never listens and the container 502s.
    await closePool();
  });
