/**
 * Operation Commands
 */

import { Command } from 'commander';
import { db } from '#drizzle/db';
import { workflowOperations } from '#drizzle/schema';
import { eq, desc, and } from 'drizzle-orm';
import { z } from 'zod';
import { output, outputJson, printError, printSection, c } from '../lib/output';
import { operationColumns, printOperationDetail } from '../lib/formatters/workflow';
import { classifyJson, jsonValueSchema, operationRowSchema } from '../lib/schemas';
import type { JsonValue } from '../lib/transport';
import type { OutputFormat } from '../lib/types';

const operationRowsSchema = z.array(operationRowSchema);

/** One-line rendering of a JSON value for the `--summary` view. */
function describeJsonValue(value: JsonValue): string {
  const decoded = classifyJson(value);
  switch (decoded.kind) {
    case 'string':
      return decoded.value.length > 100 ? `${decoded.value.slice(0, 100)}...` : decoded.value;
    case 'number':
    case 'boolean':
      return String(decoded.value);
    case 'null':
      return 'null';
    case 'array':
      return `Array(${decoded.items.length})`;
    case 'object':
      return `Object(${decoded.entries.length} keys)`;
  }
}

export function registerOperationCommands(program: Command): void {
  const operation = program
    .command('operation')
    .description('Manage workflow operations');

  // List operations
  operation
    .command('list')
    .description('List operations')
    .option('-f, --format <format>', 'Output format: table, json, ids', 'table')
    .option('-l, --limit <n>', 'Limit results', '20')
    .option('--offset <n>', 'Offset for pagination', '0')
    .option('--status <status>', 'Filter by status (pending, running, completed, failed, skipped)')
    .option('--workflow <id>', 'Filter by workflow ID')
    .option('--type <type>', 'Filter by operation type')
    .option('--failed', 'Show only failed operations')
    .action(async (options) => {
      await listOperations(options);
    });

  // Get operation by ID
  operation
    .command('get <id>')
    .description('Get operation details by ID')
    .option('-f, --format <format>', 'Output format: table, json', 'table')
    .action(async (id, options) => {
      await getOperation(id, options);
    });

  // Get operation result data
  operation
    .command('data <id>')
    .description('Get operation result data')
    .option('--summary', 'Show summary instead of full data')
    .action(async (id, options) => {
      await getOperationData(id, options);
    });

  // Get operation error/logs
  operation
    .command('logs <id>')
    .description('Get operation error and logs')
    .option('--full', 'Show full error details')
    .action(async (id, options) => {
      await getOperationLogs(id, options);
    });

  // Find operations by criteria
  operation
    .command('find')
    .description('Find operations by criteria')
    .option('-f, --format <format>', 'Output format: table, json', 'table')
    .option('--type <type>', 'Operation type pattern')
    .option('--status <status>', 'Operation status')
    .option('--stage <stage>', 'Workflow stage')
    .option('-l, --limit <n>', 'Limit results', '20')
    .action(async (options) => {
      await findOperations(options);
    });

  // Operation stats
  operation
    .command('stats')
    .description('Show operation statistics')
    .option('--workflow <id>', 'Filter by workflow ID')
    .action(async (options) => {
      await showOperationStats(options);
    });
}

interface ListOperationsOptions {
  format: OutputFormat;
  limit: string;
  offset: string;
  status?: string;
  workflow?: string;
  type?: string;
  failed?: boolean;
}

async function listOperations(options: ListOperationsOptions): Promise<void> {
  const limit = parseInt(options.limit, 10);
  const offset = parseInt(options.offset, 10);

  // Build conditions
  const conditions = [];
  if (options.status) {
    conditions.push(eq(workflowOperations.status, options.status));
  }
  if (options.workflow) {
    conditions.push(eq(workflowOperations.workflowId, options.workflow));
  }
  if (options.type) {
    conditions.push(eq(workflowOperations.type, options.type));
  }
  if (options.failed) {
    conditions.push(eq(workflowOperations.status, 'failed'));
  }

  const allOperations = await db.query.workflowOperations.findMany({
    where: conditions.length > 0 ? and(...conditions) : undefined,
    orderBy: [desc(workflowOperations.createdAt)],
  });

  const total = allOperations.length;
  const paginatedOperations = allOperations.slice(offset, offset + limit);

  output(
    options.format,
    operationRowsSchema.parse(paginatedOperations),
    operationColumns,
    { total, limit, offset },
  );
}

async function getOperation(id: string, options: { format: OutputFormat }): Promise<void> {
  const operation = await db.query.workflowOperations.findFirst({
    where: eq(workflowOperations.id, id),
  });

  if (!operation) {
    printError(`Operation with ID ${id} not found`);
    process.exitCode = 1;
    return;
  }

  if (options.format === 'json') {
    outputJson(operation);
    return;
  }

  printOperationDetail(operationRowSchema.parse(operation));
}

async function getOperationData(id: string, options: { summary?: boolean }): Promise<void> {
  const operation = await db.query.workflowOperations.findFirst({
    where: eq(workflowOperations.id, id),
  });

  if (!operation) {
    printError(`Operation with ID ${id} not found`);
    process.exitCode = 1;
    return;
  }

  if (!operation.result) {
    printError('Operation has no result data');
    return;
  }

  const result = jsonValueSchema.parse(operation.result);

  if (!options.summary) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  const decoded = classifyJson(result);
  printSection('Operation Result Summary');
  console.log(`Type: ${decoded.kind}`);
  if (decoded.kind !== 'object') {
    console.log(`  ${describeJsonValue(result)}`);
    return;
  }

  console.log(`Keys: ${decoded.entries.map(([key]) => key).join(', ')}`);
  for (const [key, value] of decoded.entries) {
    console.log(`  ${key}: ${describeJsonValue(value)}`);
  }
}

async function getOperationLogs(id: string, options: { full?: boolean }): Promise<void> {
  const operation = await db.query.workflowOperations.findFirst({
    where: eq(workflowOperations.id, id),
  });

  if (!operation) {
    printError(`Operation with ID ${id} not found`);
    process.exitCode = 1;
    return;
  }

  if (!operation.errorMessage) {
    console.log(c.dim('No error message for this operation'));
    return;
  }

  printSection('Error Message');
  console.log(c.red(operation.errorMessage));

  // Check if result contains additional error info
  if (!operation.result || !options.full) return;

  const decoded = classifyJson(jsonValueSchema.parse(operation.result));
  if (decoded.kind !== 'object') return;

  const details = new Map(decoded.entries);
  const errorDetail = details.get('error');
  const stackDetail = details.get('stack');
  const extraDetail = details.get('details');
  if (!errorDetail && !stackDetail && !extraDetail) return;

  printSection('Additional Error Details');
  if (errorDetail) console.log(`Error: ${describeJsonValue(errorDetail)}`);
  if (stackDetail) {
    printSection('Stack Trace');
    console.log(c.dim(String(stackDetail)));
  }
  if (extraDetail) {
    printSection('Details');
    console.log(JSON.stringify(extraDetail, null, 2));
  }
}

interface FindOperationsOptions {
  format: OutputFormat;
  type?: string;
  status?: string;
  stage?: string;
  limit: string;
}

async function findOperations(options: FindOperationsOptions): Promise<void> {
  const limit = parseInt(options.limit, 10);

  // Build conditions
  const conditions = [];
  if (options.status) {
    conditions.push(eq(workflowOperations.status, options.status));
  }
  if (options.type) {
    conditions.push(eq(workflowOperations.type, options.type));
  }
  if (options.stage) {
    conditions.push(eq(workflowOperations.stage, options.stage));
  }

  if (conditions.length === 0) {
    printError('At least one search criterion is required (--type, --status, or --stage)');
    process.exitCode = 1;
    return;
  }

  const operations = await db.query.workflowOperations.findMany({
    where: and(...conditions),
    orderBy: [desc(workflowOperations.createdAt)],
    limit,
  });

  output(options.format, operationRowsSchema.parse(operations), operationColumns, {
    total: operations.length,
    limit,
    offset: 0,
  });
}

async function showOperationStats(options: { workflow?: string }): Promise<void> {
  const conditions = options.workflow
    ? eq(workflowOperations.workflowId, options.workflow)
    : undefined;

  const allOperations = await db.query.workflowOperations.findMany({
    where: conditions,
  });

  // Calculate stats
  const byStatus = new Map<string, number>();
  const byType = new Map<string, number>();
  const byStage = new Map<string, number>();

  let totalAttempts = 0;
  for (const op of allOperations) {
    byStatus.set(op.status, (byStatus.get(op.status) ?? 0) + 1);
    byType.set(op.type, (byType.get(op.type) ?? 0) + 1);
    byStage.set(op.stage, (byStage.get(op.stage) ?? 0) + 1);
    totalAttempts += op.attempts;
  }
  const avgAttempts = allOperations.length > 0 ? totalAttempts / allOperations.length : 0;

  printSection('Operation Statistics');
  console.log(`Total operations: ${c.bold(String(allOperations.length))}`);
  console.log(`Average attempts: ${avgAttempts.toFixed(2)}`);

  printCounts('By Status', byStatus);
  printCounts('By Type', byType);
  printCounts('By Stage', byStage);
}

function printCounts(title: string, counts: Map<string, number>): void {
  printSection(title);
  for (const [label, count] of [...counts].toSorted((a, b) => b[1] - a[1])) {
    console.log(`  ${label}: ${count}`);
  }
}
