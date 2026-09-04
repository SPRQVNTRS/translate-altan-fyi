/**
 * API Key Commands
 *
 * `create` is the bootstrap exception (ADR-0001): it writes to the database
 * directly, because it is what mints the credential every other remote command
 * needs. `list` and `revoke` go through the transport like everything else.
 */

import { Command } from 'commander';
import { createApiKey } from '#app/models/api-keys.server';
import { output, printError, printSuccess, printWarning } from '../lib/output';
import { apiKeyColumns } from '../lib/formatters/api-key';
import type { OutputFormat } from '../lib/types';
import { transport } from '../lib/transport';
import { apiKeyListSchema, apiKeyRevokeSchema } from '../lib/schemas';

export function registerApiKeyCommands(program: Command): void {
  const apiKey = program.command('api-key').description('Manage API keys');

  apiKey
    .command('list')
    .description('List the API keys on this installation')
    .option('-f, --format <format>', 'Output format: table, json', 'table')
    .option('-l, --limit <n>', 'Limit results', '20')
    .option('--offset <n>', 'Offset for pagination', '0')
    .action(async (options: { format: OutputFormat; limit: string; offset: string }) => {
      await listKeys(options);
    });

  apiKey
    .command('create')
    .description('Create a new API key')
    .requiredOption('--name <name>', 'Key name/label')
    .option('--superadmin', 'Let the key reach the superadmin endpoints', false)
    .action(async (options: { name: string; superadmin: boolean }) => {
      await createKey(options);
    });

  apiKey
    .command('revoke <id>')
    .description('Revoke an API key')
    .action(async (id: string) => {
      await revokeKey(id);
    });
}

async function listKeys(options: {
  format: OutputFormat;
  limit: string;
  offset: string;
}): Promise<void> {
  const limit = parseInt(options.limit, 10);
  const offset = parseInt(options.offset, 10);

  const envelope = await transport.get('/api/v1/api-keys', apiKeyListSchema, { limit, offset });

  if (options.format === 'json') {
    console.log(JSON.stringify(envelope, null, 2));
    return;
  }

  output(options.format, envelope.data, apiKeyColumns, {
    total: envelope.total,
    limit: envelope.limit,
    offset: envelope.offset,
  });
}

async function createKey(options: { name: string; superadmin: boolean }): Promise<void> {
  // Bootstrap: api-key create always uses the database directly.
  // --remote is intentionally ignored here. See ADR-0001.
  const { key, record } = await createApiKey({
    name: options.name,
    isSuperadmin: options.superadmin,
  });

  printSuccess(`API key created: ${record.name}${record.isSuperadmin ? ' (superadmin)' : ''}`);
  printWarning('Store this key securely, it will not be shown again:');
  console.log(`\n  ${key}\n`);
}

async function revokeKey(id: string): Promise<void> {
  const { record } = await transport.delete(`/api/v1/api-keys/${id}`, apiKeyRevokeSchema);
  if (!record) {
    printError(`API key ${id} not found`);
    process.exitCode = 1;
    return;
  }
  printSuccess(`API key "${record.name}" (${record.prefix}...) has been revoked`);
}
