/**
 * API Key Commands
 */

import { Command } from 'commander';
import { organizations } from '#drizzle/schema';
import { getRawDb } from '#drizzle/tenant-db';
import { eq } from 'drizzle-orm';
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
    .description('List API keys for an organization')
    .requiredOption('--org <slug>', 'Organization slug')
    .option('-f, --format <format>', 'Output format: table, json', 'table')
    .option('-l, --limit <n>', 'Limit results', '20')
    .option('--offset <n>', 'Offset for pagination', '0')
    .action(async (options: { org: string; format: OutputFormat; limit: string; offset: string }) => {
      await listKeys(options);
    });

  apiKey
    .command('create')
    .description('Create a new API key')
    .requiredOption('--org <slug>', 'Organization slug')
    .requiredOption('--name <name>', 'Key name/label')
    .action(async (options: { org: string; name: string }) => {
      await createKey(options);
    });

  apiKey
    .command('revoke <id>')
    .description('Revoke an API key (cross-tenant; admin)')
    .action(async (id: string) => {
      await revokeKey(id);
    });
}

async function resolveOrg(slug: string) {
  const org = await getRawDb().query.organizations.findFirst({
    where: eq(organizations.slug, slug),
  });
  if (!org) {
    printError(`Organization "${slug}" not found`);
    process.exitCode = 1;
    return null;
  }
  return org;
}

async function listKeys(options: {
  org: string;
  format: OutputFormat;
  limit: string;
  offset: string;
}): Promise<void> {
  const limit = parseInt(options.limit, 10);
  const offset = parseInt(options.offset, 10);

  const envelope = await transport.get('/api/v1/api-keys', apiKeyListSchema, {
    org: options.org,
    limit,
    offset,
  });

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

async function createKey(options: { org: string; name: string }): Promise<void> {
  // Bootstrap: api-key create always uses the database directly.
  // --remote is intentionally ignored here. See ADR-0001.
  const org = await resolveOrg(options.org);
  if (!org) return;

  const { key, record } = await createApiKey(
    { orgId: org.id },
    { name: options.name, createdBy: null },
  );

  printSuccess(`API key created: ${record.name}`);
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
