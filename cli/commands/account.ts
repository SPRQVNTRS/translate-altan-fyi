/**
 * Account Commands
 *
 * DIRECT-DB, AND THAT IS A BOOTSTRAP EXCEPTION (ADR-0001). Every other command
 * group routes through the transport abstraction, because the HTTP layer is
 * where auth, tenancy and audit live. This one cannot: it grants the flag that
 * decides who may reach an admin surface, so requiring an authenticated admin
 * call to create the first admin is a bootstrap that never starts. It sits
 * beside `user create` and `api-key create` for the same reason, and it is the
 * only account subcommand that will ever be allowed to.
 */

import { Command } from 'commander';
import { eq } from 'drizzle-orm';
import { accounts } from '#drizzle/schema';
import { getRawDb } from '#drizzle/tenant-db';
import { normalizeHandle } from '#app/lib/e2ee/verifier';
import { printError, printSuccess } from '../lib/output';

export function registerAccountCommands(program: Command): void {
  const account = program
    .command('account')
    .description('Manage end-to-end-encrypted personal-layer accounts');

  account
    .command('grant-superadmin <handle>')
    .description('Grant superadmin privileges to an account')
    .action(async (handle: string) => {
      await grantSuperadminCmd(handle);
    });
}

// ---------------------------------------------------------------------------
// Command implementations
// ---------------------------------------------------------------------------

async function grantSuperadminCmd(rawHandle: string): Promise<void> {
  // Normalized with the SAME function the signup path uses, never lowercased by
  // hand: `normalizeHandle` is NFKC + trim + lowercase, and the unique index is
  // over that form. A hand-rolled `toLowerCase()` here would fail to find an
  // account whose handle carries a composed character.
  const handle = normalizeHandle(rawHandle);

  const [updated] = await getRawDb()
    .update(accounts)
    .set({ isSuperadmin: true })
    .where(eq(accounts.handle, handle))
    .returning({ id: accounts.id, handle: accounts.handle });

  if (!updated) {
    printError(`No account with handle "${handle}". Handles are normalized, so check the spelling as the account was created.`);
    process.exitCode = 1;
    return;
  }

  printSuccess(`Superadmin privileges granted to account ${updated.id} ("${updated.handle}")`);
}
