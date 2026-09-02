/**
 * User Commands
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
import { output, outputJson, printError, printSuccess, printWarning } from '../lib/output';
import { userDetailSchema, userListSchema } from '../lib/schemas';
import { userColumns, printUserDetail } from '../lib/formatters/user';
import type { OutputFormat } from '../lib/types';

export function registerUserCommands(program: Command): void {
  const user = program
    .command('user')
    .description('Manage users');

  user
    .command('list')
    .description('List all users')
    .option('-f, --format <format>', 'Output format: table, json, ids', 'table')
    .option('-l, --limit <n>', 'Limit results', '50')
    .option('--offset <n>', 'Offset for pagination', '0')
    .option('--active', 'Show only active users')
    .option('--deactivated', 'Show only deactivated users')
    .option('--superadmin', 'Show only superadmins')
    .action(async (options: {
      format: OutputFormat;
      limit: string;
      offset: string;
      active?: boolean;
      deactivated?: boolean;
      superadmin?: boolean;
    }) => {
      await listUsersCmd(options);
    });

  user
    .command('get <id>')
    .description('Get user details by ID')
    .option('-f, --format <format>', 'Output format: table, json', 'table')
    .action(async (id: string, options: { format: OutputFormat }) => {
      await getUserCmd(parseInt(id, 10), options);
    });

  user
    .command('find <email>')
    .description('Find user by email')
    .option('-f, --format <format>', 'Output format: table, json', 'table')
    .action(async (email: string, options: { format: OutputFormat }) => {
      await findUserByEmailCmd(email, options);
    });

  user
    .command('activate <id>')
    .description('Activate a deactivated user')
    .action(async (id: string) => {
      await setUserActiveCmd(parseInt(id, 10), true);
    });

  user
    .command('deactivate <id>')
    .description('Deactivate a user')
    .action(async (id: string) => {
      await setUserActiveCmd(parseInt(id, 10), false);
    });

  user
    .command('grant-superadmin <id>')
    .description('Grant superadmin privileges to a user')
    .option('--force', 'Skip confirmation')
    .action(async (id: string, options: { force?: boolean }) => {
      await setSuperadminCmd(parseInt(id, 10), true, options.force);
    });

  user
    .command('revoke-superadmin <id>')
    .description('Revoke superadmin privileges from a user')
    .option('--force', 'Skip confirmation')
    .action(async (id: string, options: { force?: boolean }) => {
      await setSuperadminCmd(parseInt(id, 10), false, options.force);
    });
}

// ---------------------------------------------------------------------------
// Command implementations
// ---------------------------------------------------------------------------

async function listUsersCmd(options: {
  format: OutputFormat;
  limit: string;
  offset: string;
  active?: boolean;
  deactivated?: boolean;
  superadmin?: boolean;
}): Promise<void> {
  const limit = parseInt(options.limit, 10);
  const offset = parseInt(options.offset, 10);

  const envelope = await transport.get('/api/v1/users', userListSchema, {
    limit,
    offset,
    active: options.active ? 'true' : undefined,
    deactivated: options.deactivated ? 'true' : undefined,
    superadmin: options.superadmin ? 'true' : undefined,
  });

  if (options.format === 'json') {
    console.log(JSON.stringify(envelope, null, 2));
    return;
  }

  output(options.format, envelope.data, userColumns, {
    total: envelope.total,
    limit: envelope.limit,
    offset: envelope.offset,
  });
}

async function getUserCmd(id: number, options: { format: OutputFormat }): Promise<void> {
  let detail;
  try {
    detail = await transport.get(`/api/v1/users/${id}`, userDetailSchema);
  } catch (err) {
    if (err instanceof CliApiError && err.status === 404) {
      printError(`User with ID ${id} not found`);
      process.exitCode = 1;
      return;
    }
    throw err;
  }

  if (options.format === 'json') {
    outputJson(detail.user);
  } else {
    printUserDetail(detail.user);
  }
}

async function findUserByEmailCmd(email: string, options: { format: OutputFormat }): Promise<void> {
  let detail;
  try {
    detail = await transport.get(
      `/api/v1/users/by-email/${encodeURIComponent(email)}`,
      userDetailSchema,
    );
  } catch (err) {
    if (err instanceof CliApiError && err.status === 404) {
      printError(`User with email "${email}" not found`);
      process.exitCode = 1;
      return;
    }
    throw err;
  }

  if (options.format === 'json') {
    outputJson(detail.user);
  } else {
    printUserDetail(detail.user);
  }
}

async function setUserActiveCmd(id: number, active: boolean): Promise<void> {
  try {
    await transport.patch(`/api/v1/users/${id}`, userDetailSchema, { deactivated: !active });
    printSuccess(`User ${id} has been ${active ? 'activated' : 'deactivated'}`);
  } catch (err) {
    if (err instanceof CliApiError && err.status === 404) {
      printError(`User with ID ${id} not found`);
      process.exitCode = 1;
      return;
    }
    throw err;
  }
}

async function setSuperadminCmd(id: number, grant: boolean, force?: boolean): Promise<void> {
  if (!force) {
    printWarning(`This will ${grant ? 'grant' : 'revoke'} superadmin privileges for user ${id}`);
    printWarning('Use --force to confirm this action');
    return;
  }

  try {
    await transport.patch(`/api/v1/users/${id}`, userDetailSchema, { isSuperadmin: grant });
    printSuccess(`Superadmin privileges ${grant ? 'granted to' : 'revoked from'} user ${id}`);
  } catch (err) {
    if (err instanceof CliApiError && err.status === 404) {
      printError(`User with ID ${id} not found`);
      process.exitCode = 1;
      return;
    }
    throw err;
  }
}
