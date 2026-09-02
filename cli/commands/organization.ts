/**
 * Organization Commands
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
  output,
  outputJson,
  outputTable,
  printError,
  printSuccess,
  printWarning,
  printSection,
} from '../lib/output';
import {
  organizationColumns,
  printOrganizationDetail,
  memberColumns,
} from '../lib/formatters/organization';
import {
  memberListSchema,
  organizationDeleteSchema,
  organizationDetailSchema,
  organizationListSchema,
} from '../lib/schemas';
import type { OutputFormat } from '../lib/types';

export function registerOrganizationCommands(program: Command): void {
  const org = program
    .command('org')
    .description('Manage organizations');

  org
    .command('list')
    .description('List all organizations')
    .option('-f, --format <format>', 'Output format: table, json, ids', 'table')
    .option('-l, --limit <n>', 'Limit results', '50')
    .option('--offset <n>', 'Offset for pagination', '0')
    .action(async (options: { format: OutputFormat; limit: string; offset: string }) => {
      await listOrgsCmd(options);
    });

  org
    .command('get <idOrSlug>')
    .description('Get organization details by ID or slug')
    .option('-f, --format <format>', 'Output format: table, json', 'table')
    .option('--with-members', 'Include organization members')
    .action(async (idOrSlug: string, options: { format: OutputFormat; withMembers?: boolean }) => {
      await getOrgCmd(idOrSlug, options);
    });

  org
    .command('members <idOrSlug>')
    .description('List members of an organization')
    .option('-f, --format <format>', 'Output format: table, json', 'table')
    .option('-l, --limit <n>', 'Limit results', '20')
    .option('--offset <n>', 'Offset for pagination', '0')
    .action(async (idOrSlug: string, options: { format: OutputFormat; limit?: string; offset?: string }) => {
      await listMembersCmd(idOrSlug, options);
    });

  org
    .command('delete <idOrSlug>')
    .description('Delete an organization')
    .option('--force', 'Skip confirmation')
    .option('--dry-run', 'Preview what would be deleted')
    .action(async (idOrSlug: string, options: { force?: boolean; dryRun?: boolean }) => {
      await deleteOrgCmd(idOrSlug, options);
    });
}

// ---------------------------------------------------------------------------
// Command implementations
// ---------------------------------------------------------------------------

async function listOrgsCmd(options: {
  format: OutputFormat;
  limit: string;
  offset: string;
}): Promise<void> {
  const limit = parseInt(options.limit, 10);
  const offset = parseInt(options.offset, 10);

  const envelope = await transport.get('/api/v1/orgs', organizationListSchema, {
    limit,
    offset,
  });

  if (options.format === 'json') {
    console.log(JSON.stringify(envelope, null, 2));
    return;
  }

  output(options.format, envelope.data, organizationColumns, {
    total: envelope.total,
    limit: envelope.limit,
    offset: envelope.offset,
  });
}

async function getOrgCmd(
  idOrSlug: string,
  options: { format: OutputFormat; withMembers?: boolean },
): Promise<void> {
  let detail;
  try {
    detail = await transport.get(`/api/v1/orgs/${idOrSlug}`, organizationDetailSchema, {
      withMembers: options.withMembers ? 'true' : undefined,
    });
  } catch (err) {
    if (err instanceof CliApiError && err.status === 404) {
      printError(`Organization "${idOrSlug}" not found`);
      process.exitCode = 1;
      return;
    }
    throw err;
  }

  const { org, members } = detail;

  if (options.format === 'json') {
    outputJson(options.withMembers ? { ...org, members } : org);
    return;
  }

  printOrganizationDetail(org);

  if (options.withMembers && members && members.length > 0) {
    printSection('Members');
    outputTable(members, memberColumns);
  }
}

async function listMembersCmd(
  idOrSlug: string,
  options: { format: OutputFormat; limit?: string; offset?: string },
): Promise<void> {
  const limit = parseInt(options.limit ?? '20', 10);
  const offset = parseInt(options.offset ?? '0', 10);

  let envelope;
  try {
    envelope = await transport.get(`/api/v1/orgs/${idOrSlug}/members`, memberListSchema, {
      limit,
      offset,
    });
  } catch (err) {
    if (err instanceof CliApiError && err.status === 404) {
      printError(`Organization "${idOrSlug}" not found`);
      process.exitCode = 1;
      return;
    }
    throw err;
  }

  if (options.format === 'json') {
    console.log(JSON.stringify(envelope, null, 2));
    return;
  }

  if (envelope.data.length === 0) {
    printWarning(`Organization "${idOrSlug}" has no members`);
    return;
  }

  outputTable(envelope.data, memberColumns, {
    total: envelope.total,
    limit: envelope.limit,
    offset: envelope.offset,
  });
}

async function deleteOrgCmd(
  idOrSlug: string,
  options: { force?: boolean; dryRun?: boolean },
): Promise<void> {
  if (options.dryRun) {
    let detail;
    try {
      detail = await transport.get(`/api/v1/orgs/${idOrSlug}`, organizationDetailSchema, {
        withMembers: 'true',
      });
    } catch (err) {
      if (err instanceof CliApiError && err.status === 404) {
        printError(`Organization "${idOrSlug}" not found`);
        process.exitCode = 1;
        return;
      }
      throw err;
    }

    printSection('Dry Run - Would Delete');
    console.log(`Organization: ${detail.org.name} (${detail.org.id})`);
    console.log(`Members: ${detail.members?.length ?? 0}`);
    console.log('\nNo changes made.');
    return;
  }

  if (!options.force) {
    printWarning(`This will permanently delete organization "${idOrSlug}"`);
    printWarning('Use --force to confirm this action, or --dry-run to preview');
    return;
  }

  try {
    await transport.delete(`/api/v1/orgs/${idOrSlug}`, organizationDeleteSchema, {
      force: 'true',
    });
    printSuccess(`Organization "${idOrSlug}" has been deleted`);
  } catch (err) {
    if (err instanceof CliApiError && err.status === 404) {
      printError(`Organization "${idOrSlug}" not found`);
      process.exitCode = 1;
      return;
    }
    throw err;
  }
}
