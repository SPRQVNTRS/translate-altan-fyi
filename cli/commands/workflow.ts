/**
 * Workflow Commands
 *
 * All subcommands route through the transport abstraction. In HTTP mode
 * (--remote flag), requests go to the REST API. In direct mode (default),
 * they dispatch in-process via DirectTransport handlers registered in
 * cli/lib/direct-transport-handlers.ts.
 */

import { Command } from 'commander';
import {
  transport,
  CliApiError,
} from '../lib/transport';
import {
  workflowCancelSchema,
  workflowContextSchema,
  workflowDetailSchema,
  workflowListSchema,
  workflowStatsSchema,
  workflowTenancyAuditSchema,
  operationListSchema,
} from '../lib/schemas';
import {
  output,
  outputJson,
  outputTable,
  printError,
  printSuccess,
  printWarning,
  printSection,
  c,
} from '../lib/output';
import {
  workflowColumns,
  printWorkflowDetail,
  operationColumns,
} from '../lib/formatters/workflow';
import type { OutputFormat } from '../lib/types';

export function registerWorkflowCommands(program: Command): void {
  const workflow = program
    .command('workflow')
    .description('Manage workflows');

  // List workflows
  workflow
    .command('list')
    .description('List workflows')
    .option('-f, --format <format>', 'Output format: table, json, ids', 'table')
    .option('-l, --limit <n>', 'Limit results', '20')
    .option('--offset <n>', 'Offset for pagination', '0')
    .option('--status <status>', 'Filter by status (pending, running, completed, failed, cancelled)')
    .option('--type <type>', 'Filter by workflow type')
    .option('--org <orgId>', 'Filter by organization ID or slug')
    .action(async (options: {
      format: OutputFormat;
      limit: string;
      offset: string;
      status?: string;
      type?: string;
      org?: string;
    }) => {
      await listWorkflowsCmd(options);
    });

  // Get workflow by ID
  workflow
    .command('get <id>')
    .description('Get workflow details by ID')
    .option('-f, --format <format>', 'Output format: table, json', 'table')
    .option('--with-operations', 'Include workflow operations')
    .action(async (id: string, options: { format: OutputFormat; withOperations?: boolean }) => {
      await getWorkflowCmd(id, options);
    });

  // List operations for a workflow
  workflow
    .command('operations <workflowId>')
    .description('List operations for a workflow')
    .option('-f, --format <format>', 'Output format: table, json', 'table')
    .option('-l, --limit <n>', 'Limit results', '20')
    .option('--offset <n>', 'Offset for pagination', '0')
    .option('--status <status>', 'Filter by status')
    .action(async (workflowId: string, options: { format: OutputFormat; status?: string; limit?: string; offset?: string }) => {
      await listOperationsCmd(workflowId, options);
    });

  // Get workflow context
  workflow
    .command('context <id>')
    .description('Get workflow context JSON')
    .action(async (id: string) => {
      await getWorkflowContextCmd(id);
    });

  // Cancel workflow
  workflow
    .command('cancel <id>')
    .description('Cancel a pending or running workflow')
    .option('--force', 'Force cancel even if running')
    .action(async (id: string, options: { force?: boolean }) => {
      await cancelWorkflowCmd(id, options);
    });

  // Workflow stats
  workflow
    .command('stats')
    .description('Show workflow statistics')
    .option('--org <orgId>', 'Filter by organization ID or slug')
    .action(async (options: { org?: string }) => {
      await showStatsCmd(options);
    });

  // Audit JSONB tenancy coverage
  workflow
    .command('audit-tenancy')
    .description(
      "Audit workflows.context for tenancy: count rows by extracted organizationId. " +
        "Highlights rows missing context->>'organizationId' (potential cross-tenant pollution).",
    )
    .action(async () => {
      await auditTenancyCmd();
    });
}

// ---------------------------------------------------------------------------
// Command implementations
// ---------------------------------------------------------------------------

async function listWorkflowsCmd(options: {
  format: OutputFormat;
  limit: string;
  offset: string;
  status?: string;
  type?: string;
  org?: string;
}): Promise<void> {
  const limit = parseInt(options.limit, 10);
  const offset = parseInt(options.offset, 10);

  const envelope = await transport.get('/api/v1/workflows', workflowListSchema, {
    org: options.org,
    status: options.status,
    type: options.type,
    limit,
    offset,
  });

  if (options.format === 'json') {
    console.log(JSON.stringify(envelope, null, 2));
    return;
  }

  output(options.format, envelope.data, workflowColumns, {
    total: envelope.total,
    limit: envelope.limit,
    offset: envelope.offset,
  });
}

async function getWorkflowCmd(
  id: string,
  options: { format: OutputFormat; withOperations?: boolean },
): Promise<void> {
  const { workflow, operations } = await transport.get(
    `/api/v1/workflows/${id}`,
    workflowDetailSchema,
    { withOperations: options.withOperations ? 'true' : undefined },
  );

  if (options.format === 'json') {
    outputJson(options.withOperations ? { ...workflow, operations } : workflow);
    return;
  }

  printWorkflowDetail(workflow);

  if (options.withOperations && operations && operations.length > 0) {
    printSection('Operations');
    outputTable(operations, operationColumns);
  }
}

async function listOperationsCmd(
  workflowId: string,
  options: { format: OutputFormat; status?: string; limit?: string; offset?: string },
): Promise<void> {
  const limit = parseInt(options.limit ?? '20', 10);
  const offset = parseInt(options.offset ?? '0', 10);

  const envelope = await transport.get(
    `/api/v1/workflows/${workflowId}/operations`,
    operationListSchema,
    { status: options.status, limit, offset },
  );

  if (options.format === 'json') {
    console.log(JSON.stringify(envelope, null, 2));
    return;
  }

  if (envelope.data.length === 0) {
    printWarning(`Workflow ${workflowId} has no operations`);
    return;
  }

  outputTable(envelope.data, operationColumns, {
    total: envelope.total,
    limit: envelope.limit,
    offset: envelope.offset,
  });
}

async function getWorkflowContextCmd(id: string): Promise<void> {
  const context = await transport.get(`/api/v1/workflows/${id}/context`, workflowContextSchema);
  // Response body IS the context object directly — print it as-is
  console.log(JSON.stringify(context, null, 2));
}

async function cancelWorkflowCmd(id: string, options: { force?: boolean }): Promise<void> {
  try {
    await transport.post(`/api/v1/workflows/${id}/cancel`, workflowCancelSchema, {
      force: options.force ?? false,
    });
    printSuccess(`Workflow ${id} has been cancelled`);
  } catch (err) {
    if (err instanceof CliApiError) {
      if (err.status === 404) {
        printError(`Workflow ${id} not found`);
        process.exitCode = 1;
      } else if (err.status === 409) {
        printWarning('Workflow cannot be cancelled in its current state');
      } else {
        throw err;
      }
      return;
    }
    throw err;
  }
}

async function showStatsCmd(options: { org?: string }): Promise<void> {
  const stats = await transport.get('/api/v1/workflows/stats', workflowStatsSchema, {
    org: options.org,
  });

  printSection('Workflow Statistics');
  console.log(`Total workflows: ${c.bold(String(stats.total))}`);

  printSection('By Status');
  for (const [status, count] of Object.entries(stats.byStatus).toSorted((a, b) => b[1] - a[1])) {
    console.log(`  ${status}: ${count}`);
  }

  printSection('By Type');
  for (const [type, count] of Object.entries(stats.byType).toSorted((a, b) => b[1] - a[1])) {
    console.log(`  ${type}: ${count}`);
  }
}

async function auditTenancyCmd(): Promise<void> {
  const { totals, missing, orphans } = await transport.get(
    '/api/v1/workflows/audit-tenancy',
    workflowTenancyAuditSchema,
  );

  const tenanted = totals.filter((r) => r.organizationId !== null);

  printSection('Workflow Tenancy Audit');
  console.log(`Total tenants represented: ${c.bold(String(tenanted.length))}`);
  console.log(
    `Rows missing context->>'organizationId': ${missing > 0 ? c.bold(String(missing)) : '0'}`,
  );
  if (missing > 0) {
    printWarning(
      "These rows are invisible to every tenant view and likely orphaned by the pre-refactor leak.",
    );
  }

  printSection('By organizationId');
  for (const row of totals) {
    const label = row.organizationId ?? c.bold('(missing)');
    console.log(`  ${label}: ${row.count}`);
  }

  if (orphans.length > 0) {
    printSection('Orphaned tenant references');
    printWarning(
      'These organizationId values exist in workflows.context but no longer match any organization:',
    );
    for (const id of orphans) console.log(`  ${id}`);
  } else {
    console.log(`\nNo orphaned tenant references.`);
  }
}
