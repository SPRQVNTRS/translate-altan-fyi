/**
 * Data Source Commands
 */

import { Command } from 'commander';
import { transport } from '../lib/transport';
import { dataSourceListSchema } from '../lib/schemas';
import { output } from '../lib/output';
import { dataSourceColumns } from '../lib/formatters/data-source';
import type { OutputFormat } from '../lib/types';

export function registerDataSourceCommands(program: Command): void {
  const dataSource = program.command('data-source').description('Manage data sources');

  dataSource
    .command('list')
    .description('List data sources')
    .requiredOption('--org <slug>', 'Organization slug')
    .option('-f, --format <format>', 'Output format: table, json', 'table')
    .option('-l, --limit <n>', 'Limit results', '20')
    .option('--offset <n>', 'Offset for pagination', '0')
    .action(async (options: { org: string; format: OutputFormat; limit: string; offset: string }) => {
      await listSources(options);
    });
}

async function listSources(options: {
  org: string;
  format: OutputFormat;
  limit: string;
  offset: string;
}): Promise<void> {
  const limit = parseInt(options.limit, 10);
  const offset = parseInt(options.offset, 10);

  const envelope = await transport.get('/api/v1/data-sources', dataSourceListSchema, {
    org: options.org,
    limit,
    offset,
  });

  if (options.format === 'json') {
    console.log(JSON.stringify(envelope, null, 2));
    return;
  }

  output(options.format, envelope.data, dataSourceColumns, {
    total: envelope.total,
    limit: envelope.limit,
    offset: envelope.offset,
  });
}
