/**
 * Account Commands
 *
 * DIRECT-DB, AND THAT IS A BOOTSTRAP EXCEPTION (ADR-0001). Every other command
 * group routes through the transport abstraction, because the HTTP layer is
 * where auth and audit live. This one cannot: it grants the flag that decides
 * who may reach an operator surface, so requiring an authenticated admin call
 * to create the first admin is a bootstrap that never starts. It sits beside
 * `api-key create` for the same reason.
 *
 * ADDRESSES, NOT HANDLES, SINCE M191. The account model is an email and a
 * password now, so an operator addresses a person by the address they signed up
 * with. The address is normalized with the SAME function the signup path uses,
 * never lowercased by hand, because the unique index is over that form.
 */

import { Command } from 'commander';
import { desc, eq } from 'drizzle-orm';
import { users } from '#drizzle/schema';
import { getRawDb } from '#drizzle/db';
import { normalizeEmail } from '#app/lib/auth/email';
import { formatDate, outputTable, printError, printSuccess } from '../lib/output';
import type { OutputFormat, TableColumn } from '../lib/types';

interface UserRow {
  id: number;
  email: string;
  verified: string;
  superadmin: string;
  createdAt: Date;
}

const userColumns: TableColumn<UserRow>[] = [
  { header: 'ID', key: 'id' },
  { header: 'Email', key: 'email' },
  { header: 'Verified', key: 'verified' },
  { header: 'Superadmin', key: 'superadmin' },
  { header: 'Created', key: (row) => formatDate(row.createdAt) },
];

export function registerAccountCommands(program: Command): void {
  const account = program.command('account').description('Manage the accounts on this installation');

  account
    .command('grant-superadmin <email>')
    .description('Grant superadmin privileges to an account')
    .action(async (email: string) => {
      await setSuperadminCmd({ email, isSuperadmin: true });
    });

  account
    .command('revoke-superadmin <email>')
    .description('Remove superadmin privileges from an account')
    .action(async (email: string) => {
      await setSuperadminCmd({ email, isSuperadmin: false });
    });

  account
    .command('list')
    .description('List the accounts on this installation')
    .option('-f, --format <format>', 'Output format: table, json', 'table')
    .action(async (options: { format: OutputFormat }) => {
      await listAccountsCmd(options);
    });
}

// ---------------------------------------------------------------------------
// Command implementations
// ---------------------------------------------------------------------------

async function setSuperadminCmd(input: { email: string; isSuperadmin: boolean }): Promise<void> {
  const email = normalizeEmail(input.email);

  const [updated] = await getRawDb()
    .update(users)
    .set({ isSuperadmin: input.isSuperadmin })
    .where(eq(users.email, email))
    .returning({ id: users.id, email: users.email });

  if (!updated) {
    printError(`No account for "${email}". Addresses are stored lower-cased, so check the spelling.`);
    process.exitCode = 1;
    return;
  }

  const verb = input.isSuperadmin ? 'granted to' : 'revoked from';
  printSuccess(`Superadmin privileges ${verb} account ${updated.id} ("${updated.email}")`);
}

async function listAccountsCmd(options: { format: OutputFormat }): Promise<void> {
  // `password_hash` is not selected, on purpose. It is not a password, but an
  // operator listing has no reason to put one on a terminal or into a shell
  // history.
  const found = await getRawDb()
    .select({
      id: users.id,
      email: users.email,
      emailVerifiedAt: users.emailVerifiedAt,
      isSuperadmin: users.isSuperadmin,
      createdAt: users.createdAt,
    })
    .from(users)
    .orderBy(desc(users.createdAt));

  if (options.format === 'json') {
    // A BARE ARRAY, not the `{ data, pagination }` envelope the transport-backed
    // list commands print. There is no HTTP envelope on this path to mirror, and
    // an operator piping this into `jq` should get a list where a list is what
    // was asked for.
    console.log(JSON.stringify(found, null, 2));
    return;
  }

  outputTable(
    found.map((row) => ({
      id: row.id,
      email: row.email,
      verified: row.emailVerifiedAt === null ? 'no' : 'yes',
      superadmin: row.isSuperadmin ? 'yes' : 'no',
      createdAt: row.createdAt,
    })),
    userColumns,
  );
}
