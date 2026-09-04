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
 *
 * `invite` and `list-invites` inherit that exception rather than widening it,
 * and the reason is the same shape one level down (ADR-0009). An invite is
 * what an account is created FROM, so an operator who has no account yet still
 * needs a way to mint one, for a first collaborator, or for themselves in
 * place of the one-shot `ACCOUNT_BOOTSTRAP_TOKEN`. A minting endpoint behind
 * the superadmin gate would be unreachable until somebody had already got
 * through the gate.
 */

import { Command } from 'commander';
import { desc, eq } from 'drizzle-orm';
import { accounts, invites } from '#drizzle/schema';
import { getRawDb } from '#drizzle/tenant-db';
import { CONFIG } from '#config';
import { normalizeHandle } from '#app/lib/e2ee/verifier';
import {
  computeInviteTokenHash,
  deriveInviteTokenPepper,
  generateInviteToken,
} from '#app/lib/invites/token';
import { formatDate, outputTable, printError, printSuccess, printWarning } from '../lib/output';
import type { OutputFormat, TableColumn } from '../lib/types';

/** Days an invite stays redeemable when the operator does not say otherwise. */
const DEFAULT_INVITE_TTL_DAYS = 14;

interface InviteRow {
  id: number;
  status: string;
  mintedBy: string;
  redeemedBy: string;
  createdAt: Date;
  redeemedAt: Date | null;
  expiresAt: Date | null;
}

/**
 * DELIBERATELY WITHOUT A TOKEN COLUMN, and that is the contract this command
 * exists under rather than an oversight. The plaintext is not in the database
 * to print, and a listing that appeared to show one would be a lie the next
 * reader would trust.
 */
const inviteColumns: TableColumn<InviteRow>[] = [
  { header: 'ID', key: 'id' },
  { header: 'Status', key: 'status' },
  { header: 'Minted by', key: 'mintedBy' },
  { header: 'Redeemed by', key: 'redeemedBy' },
  { header: 'Created', key: (row) => formatDate(row.createdAt) },
  { header: 'Redeemed', key: (row) => formatDate(row.redeemedAt) },
  { header: 'Expires', key: (row) => formatDate(row.expiresAt) },
];

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

  account
    .command('invite')
    .description('Mint a signup invite and print its token once')
    .option('--minted-by <handle>', 'Attribute the invite to an existing account')
    .option(
      '--expires-in <days>',
      `Days until the invite stops being redeemable, or "never"`,
      String(DEFAULT_INVITE_TTL_DAYS),
    )
    .action(async (options: { mintedBy?: string; expiresIn: string }) => {
      await mintInviteCmd(options);
    });

  account
    .command('list-invites')
    .description('List signup invites (never shows a token, only its status)')
    .option('-f, --format <format>', 'Output format: table, json', 'table')
    .option('--pending', 'Only invites that are neither redeemed nor expired')
    .action(async (options: { format: OutputFormat; pending?: boolean }) => {
      await listInvitesCmd(options);
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

/**
 * Parses `--expires-in`. Returns the absolute instant, or `null` for an invite
 * that never expires.
 *
 * THROWS rather than falling back to the default on a bad value. An operator
 * who typed `--expires-in 3o` meant three days and would otherwise be handed a
 * fourteen-day invite while being told nothing.
 */
function resolveExpiry(value: string, now: Date): Date | null {
  if (value === 'never') return null;
  const days = Number.parseInt(value, 10);
  if (!Number.isFinite(days) || days <= 0 || String(days) !== value.trim()) {
    throw new Error(`--expires-in must be a positive whole number of days, or "never". Got "${value}".`);
  }
  return new Date(now.getTime() + days * 24 * 60 * 60 * 1000);
}

async function resolveMinter(rawHandle: string | undefined): Promise<number | null> {
  if (rawHandle === undefined) return null;
  const handle = normalizeHandle(rawHandle);
  const minter = await getRawDb().query.accounts.findFirst({
    where: eq(accounts.handle, handle),
    columns: { id: true },
  });
  if (!minter) {
    throw new Error(`No account with handle "${handle}" to attribute the invite to.`);
  }
  return minter.id;
}

async function mintInviteCmd(options: { mintedBy?: string; expiresIn: string }): Promise<void> {
  const expiresAt = resolveExpiry(options.expiresIn, new Date());
  const mintedByAccountId = await resolveMinter(options.mintedBy);

  const token = generateInviteToken();
  const pepper = deriveInviteTokenPepper(CONFIG.e2ee.serverSecret);

  const [created] = await getRawDb()
    .insert(invites)
    .values({
      tokenHash: computeInviteTokenHash({ token, pepper }),
      mintedByAccountId,
      expiresAt,
    })
    .returning({ id: invites.id, expiresAt: invites.expiresAt });

  if (!created) {
    printError('Failed to create the invite. Nothing was written and no token was issued.');
    process.exitCode = 1;
    return;
  }

  printSuccess(`Invite ${created.id} minted.`);
  // SHOWN ONCE, and that is structural rather than a policy anyone can relax:
  // only the HMAC was stored, so there is no query that could print this again.
  // Same contract as `api-key create` and as djinn's `openplate invite`.
  printWarning('This token is shown once and cannot be shown again. Copy it now:');
  console.log(`\n  ${token}\n`);
  console.log(
    created.expiresAt
      ? `Redeemable until ${formatDate(created.expiresAt)}.`
      : 'No expiry: this invite stays redeemable until it is used.',
  );
}

function describeStatus(row: { redeemedAt: Date | null; expiresAt: Date | null }, now: Date): string {
  if (row.redeemedAt) return 'redeemed';
  if (row.expiresAt && row.expiresAt.getTime() <= now.getTime()) return 'expired';
  return 'pending';
}

async function listInvitesCmd(options: { format: OutputFormat; pending?: boolean }): Promise<void> {
  const now = new Date();

  // `tokenHash` is not selected, on purpose. It is not the plaintext, but it is
  // the lookup key for every redemption, and there is no reason for an operator
  // listing to put it on a terminal or into a shell history.
  const found = await getRawDb()
    .select({
      id: invites.id,
      mintedByAccountId: invites.mintedByAccountId,
      redeemedByAccountId: invites.redeemedByAccountId,
      createdAt: invites.createdAt,
      redeemedAt: invites.redeemedAt,
      expiresAt: invites.expiresAt,
    })
    .from(invites)
    .orderBy(desc(invites.createdAt));

  const described = found.map((row) => ({
    id: row.id,
    mintedByAccountId: row.mintedByAccountId,
    redeemedByAccountId: row.redeemedByAccountId,
    createdAt: row.createdAt,
    redeemedAt: row.redeemedAt,
    expiresAt: row.expiresAt,
    status: describeStatus(row, now),
  }));
  const selected = options.pending ? described.filter((row) => row.status === 'pending') : described;

  if (options.format === 'json') {
    // A BARE ARRAY, not the `{ data, pagination }` envelope the transport-backed
    // list commands print. There is no HTTP envelope on this path to mirror, and
    // an operator piping this into `jq` should get a list where a list is what
    // was asked for.
    console.log(JSON.stringify(selected, null, 2));
    return;
  }

  outputTable(
    selected.map((row) => ({
      id: row.id,
      status: row.status,
      mintedBy: row.mintedByAccountId === null ? 'operator (CLI)' : String(row.mintedByAccountId),
      redeemedBy: row.redeemedByAccountId === null ? '-' : String(row.redeemedByAccountId),
      createdAt: row.createdAt,
      redeemedAt: row.redeemedAt,
      expiresAt: row.expiresAt,
    })),
    inviteColumns,
  );
}
