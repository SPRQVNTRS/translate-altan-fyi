/**
 * Metric Event Commands
 */

import { Command } from 'commander';
import { transport } from '../lib/transport';
import { metricEventListSchema } from '../lib/schemas';
import { output } from '../lib/output';
import { metricEventColumns } from '../lib/formatters/metric-event';
import type { OutputFormat } from '../lib/types';

export function registerMetricEventCommands(program: Command): void {
  const metricEvent = program.command('metric-event').description('Manage metric events');

  metricEvent
    .command('list')
    .description(
      'List metric events. --org optional; omitting requires a superadmin key, and without one you will get 403.',
    )
    .option('-f, --format <format>', 'Output format: table, json, ids', 'table')
    .option('-l, --limit <n>', 'Limit results', '20')
    .option('--offset <n>', 'Offset for pagination', '0')
    .option(
      '--org <slug>',
      'Filter by organization slug (optional; omit for global view with superadmin key)',
    )
    .option('--source <source>', 'Filter by source')
    .option('--type <eventType>', 'Filter by event type')
    .action(async (options: ListOptions) => {
      await listEvents(options);
    });
}

interface ListOptions {
  format: OutputFormat;
  limit: string;
  offset: string;
  org?: string;
  source?: string;
  type?: string;
}

async function listEvents(options: ListOptions): Promise<void> {
  const limit = parseInt(options.limit, 10);
  const offset = parseInt(options.offset, 10);

  const envelope = await transport.get('/api/v1/metric-events', metricEventListSchema, {
    org: options.org,
    source: options.source,
    type: options.type,
    limit,
    offset,
  });

  if (options.format === 'json') {
    console.log(JSON.stringify(envelope, null, 2));
    return;
  }

  output(options.format, envelope.data, metricEventColumns, {
    total: envelope.total,
    limit: envelope.limit,
    offset: envelope.offset,
  });
}
