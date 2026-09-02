/**
 * Database Commands
 *
 * All subcommands route through the transport abstraction. In HTTP mode
 * (--remote flag), requests go to the REST API. In direct mode (default),
 * they dispatch in-process via DirectTransport handlers registered in
 * cli/lib/direct-transport-handlers.ts.
 */

import { Command } from 'commander';
import { transport, CliApiError } from '../lib/transport';
import {
  dbCheckSchema,
  dbDescribeSchema,
  dbPoolSchema,
  dbQuerySchema,
  dbTablesSchema,
} from '../lib/schemas';
import { printSection, printSuccess, printError, c } from '../lib/output';

export function registerDbCommands(program: Command): void {
  const dbCmd = program
    .command('db')
    .description('Database utilities');

  dbCmd
    .command('check')
    .description('Check database connection')
    .action(async () => {
      await checkConnection();
    });

  dbCmd
    .command('pool')
    .description('Show connection pool statistics')
    .action(async () => {
      await showPoolStats();
    });

  dbCmd
    .command('query <sql>')
    .description('Run a read-only SQL query')
    .option('--format <format>', 'Output format: table, json', 'json')
    .action(async (sql: string, options: { format: string }) => {
      await runQuery(sql, options);
    });

  dbCmd
    .command('tables')
    .description('List all tables')
    .action(async () => {
      await listTables();
    });

  dbCmd
    .command('describe <table>')
    .description('Describe a table structure')
    .action(async (table: string) => {
      await describeTable(table);
    });
}

// ---------------------------------------------------------------------------
// Command implementations
// ---------------------------------------------------------------------------

async function checkConnection(): Promise<void> {
  try {
    const { database, user, serverTime } = await transport.get(
      '/api/v1/admin/db/check',
      dbCheckSchema,
    );

    printSection('Database Connection');
    console.log(`Status: ${c.green('Connected')}`);
    console.log(`Database: ${database}`);
    console.log(`User: ${user}`);
    console.log(`Server Time: ${serverTime.toISOString()}`);
    printSuccess('Database connection successful');
  } catch (err) {
    if (err instanceof CliApiError) {
      printError('Failed to connect to database', err.message);
    } else {
      throw err;
    }
    process.exitCode = 1;
  }
}

async function showPoolStats(): Promise<void> {
  const { total, idle, waiting, instanceNote } = await transport.get(
    '/api/v1/admin/db/pool',
    dbPoolSchema,
  );

  printSection('Connection Pool Statistics');
  console.log(`Total connections: ${total}`);
  console.log(`Idle connections: ${idle}`);
  console.log(`Waiting clients: ${waiting}`);
  if (instanceNote) {
    console.log(c.dim(`\nNote: ${instanceNote}`));
  }
}

async function runQuery(sql: string, options: { format: string }): Promise<void> {
  let result;
  try {
    result = await transport.post('/api/v1/admin/db/query', dbQuerySchema, { sql });
  } catch (err) {
    if (err instanceof CliApiError) {
      printError('Query failed', err.message);
    } else {
      throw err;
    }
    process.exitCode = 1;
    return;
  }

  const { rows, fields } = result;

  if (options.format === 'json') {
    console.log(JSON.stringify(rows, null, 2));
  } else {
    if (rows.length === 0) {
      console.log(c.dim('No results'));
      return;
    }

    console.log(fields.join('\t'));
    console.log('-'.repeat(fields.join('\t').length));
    for (const row of rows) {
      console.log(fields.map((f) => String(row[f] ?? '')).join('\t'));
    }
    console.log(c.dim(`\n${rows.length} row(s)`));
  }
}

async function listTables(): Promise<void> {
  const { data } = await transport.get('/api/v1/admin/db/tables', dbTablesSchema);

  printSection('Database Tables');
  for (const row of data) {
    console.log(`  ${row.tableName} (${row.size})`);
  }
  console.log(c.dim(`\n${data.length} table(s)`));
}

async function describeTable(table: string): Promise<void> {
  let described;
  try {
    described = await transport.get(
      `/api/v1/admin/db/describe/${encodeURIComponent(table)}`,
      dbDescribeSchema,
    );
  } catch (err) {
    if (err instanceof CliApiError && err.status === 404) {
      printError(`Table "${table}" not found`);
      process.exitCode = 1;
      return;
    }
    throw err;
  }

  const { columns } = described;

  printSection(`Table: ${table}`);
  console.log('Column\t\t\tType\t\t\tNullable\tDefault');
  console.log('-'.repeat(80));
  for (const col of columns) {
    const colName = col.columnName.padEnd(20);
    const dataType = col.dataType.padEnd(20);
    const nullable = col.isNullable === 'YES' ? 'YES' : 'NO';
    const defaultVal = col.columnDefault ? col.columnDefault.slice(0, 30) : '-';
    console.log(`${colName}\t${dataType}\t${nullable}\t\t${defaultVal}`);
  }
}
