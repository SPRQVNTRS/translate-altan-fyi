/**
 * COPIED, NOT SHARED. Source: openplate-sync/src/db/account-store.ts @ 311a1578af3ca169e8a08c6d50d90889e29d5889.
 * See .adr/0008-e2ee-sync-copied-not-extracted.md. Fixes belong upstream first,
 * then here. Do not let the two drift.
 */
/**
 * Drizzle implementation of `AccountStore` — the imperative shell under the
 * pure auth handlers.
 *
 * Two things here are load-bearing rather than incidental:
 *
 * 1. **`rotateCredential` is one transaction.** Verifier swap, KDF-descriptor
 *    swap, key-record upsert, session revocation, and the caller's new tokens
 *    all commit together or not at all. A partial application is silent data
 *    loss: a new verifier without the re-wrapped DEK leaves an account that
 *    logs in fine and can never decrypt its own blob again, with nothing to
 *    tell the user until they try.
 * 2. **Account deletion relies on `ON DELETE CASCADE`**, declared on the
 *    `sync_key_records` and `enrichment_votes` foreign keys. One DELETE
 *    removes the account and every byte of ciphertext it owns, inside
 *    Postgres, with no application-level cleanup that could be skipped or
 *    half-run. That is the self-serve erasure path.
 *
 * `getRawDb()` is the one handle this application has. Accounts, their tokens
 * and their key records belong to the person who authenticates as them.
 *
 * `.server.ts` because this module imports `#drizzle/db`. The rest of
 * `app/lib/e2ee/` is pure policy over injected interfaces and must stay
 * reachable from the client bundle; this file must never be.
 */
import { and, count, eq, gt, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import type {
  AccountAdmission,
  AccountRecord,
  AccountStore,
  CreateAccountInput,
  CreateAccountResult,
  KeyRecordSubmission,
  NewTokenInput,
  RecoverAndRotatePassphraseInput,
  RecoverAndRotatePassphraseResult,
  RotateCredentialInput,
  StoredToken,
} from './account-store';
import type { AccountTokenKind } from './tokens';
import { SESSION_TOKEN_KINDS } from './tokens';
import { isUniqueViolation } from './storage-conflict';
import { accountTokens, accounts, invites, syncKeyRecords } from '#drizzle/schema';
import { getRawDb } from '#drizzle/db';

/** The Drizzle handle this store writes through, always the raw one (see the header). */
type Database = ReturnType<typeof getRawDb>;

/**
 * Refusal signal for `recoverAndRotatePassphrase`, never thrown out of this
 * module. A `return` from a transaction callback COMMITS what has already
 * been written — the exact half-application this method exists to prevent —
 * so a refusal has to travel as a throw.
 */
class RecoveryRotationRefused extends Error {
  readonly result: RecoverAndRotatePassphraseResult;

  constructor(result: RecoverAndRotatePassphraseResult) {
    super('recovery rotation refused');
    this.name = 'RecoveryRotationRefused';
    this.result = result;
  }
}

/**
 * Refusal signal for `createAccount`, never thrown out of this module.
 *
 * Same shape and same reason as `RecoveryRotationRefused` above: a `return`
 * from a transaction callback COMMITS what has already been written, and what
 * has already been written on this path is an invite marked spent. A refusal
 * therefore has to travel as a throw, so Postgres rolls the claim back and the
 * invite stays spendable. PROTOCOL.md §5.8.1 requires exactly that of the
 * `409` case.
 */
class AccountCreationRefused extends Error {
  readonly result: CreateAccountResult;

  constructor(result: CreateAccountResult) {
    super('account creation refused');
    this.name = 'AccountCreationRefused';
    this.result = result;
  }
}

/**
 * The advisory-lock key that serialises bootstrap-token signups.
 *
 * WHY AN ADVISORY LOCK AND NOT A ROW LOCK. The bootstrap branch is admitted
 * only while `accounts` is EMPTY, and an empty table offers nothing to lock.
 * `SELECT count(*) ... FOR UPDATE` is not the answer and would look like one:
 * it locks the rows it returned, and it returned none, so two concurrent
 * bootstrap signups would both see zero and both insert. Postgres has no
 * predicate lock outside SERIALIZABLE, and raising the isolation level of this
 * one transaction would buy the same guarantee at the price of serialisation
 * failures the caller would then have to retry.
 *
 * A transaction-scoped advisory lock is the smallest thing that works: the
 * second bootstrap signup blocks on this key until the first commits, then
 * takes its count in a NEW statement snapshot, sees one account and is refused.
 * It is released by the commit or the rollback, so a crashed transaction cannot
 * strand it.
 *
 * `hashtext` is used deliberately even though it is an internal function whose
 * output is not guaranteed stable across major versions. Nothing here persists
 * the key or compares it with another release: it only has to agree among
 * sessions talking to the SAME server at the SAME moment, which it does by
 * construction.
 *
 * The invite branch takes no advisory lock and must not: it is serialised by
 * the row lock its conditional UPDATE already holds.
 */
const BOOTSTRAP_ADVISORY_LOCK_LABEL = 'translate-altan-fyi:account-bootstrap';

/**
 * A transaction handle, as drizzle hands one to a `db.transaction` callback.
 * Named so the two shared write helpers below can only be given one.
 */
type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];

type AccountRow = typeof accounts.$inferSelect;
type TokenRow = typeof accountTokens.$inferSelect;

function mapAccountRow(row: AccountRow): AccountRecord {
  return {
    id: row.id,
    handle: row.handle,
    displayName: row.displayName,
    verifier: row.verifier,
    recoveryVerifier: row.recoveryVerifier,
    kdfDescriptor: row.kdfDescriptor,
    createdAt: row.createdAt,
  };
}

function mapTokenRow(row: TokenRow): StoredToken {
  return {
    id: row.id,
    accountId: row.accountId,
    kind: row.kind,
    familyId: row.familyId,
    expiresAt: row.expiresAt,
    revokedAt: row.revokedAt,
  };
}

/** The mutable rows of a token insert, shared by the standalone and in-transaction paths. */
function tokenValues(tokens: NewTokenInput[]): (typeof accountTokens.$inferInsert)[] {
  return tokens.map((token) => ({
    accountId: token.accountId,
    kind: token.kind,
    tokenHash: token.tokenHash,
    familyId: token.familyId,
    expiresAt: token.expiresAt,
  }));
}

/**
 * Upserts the submitted re-wrapped DEKs, one row per `kind`.
 *
 * Shared by both rotations so the two can never drift: `tx` is always a
 * TRANSACTION handle, never the pool, because a key-record write that lands
 * outside its rotation's transaction is exactly the half-state both callers
 * exist to prevent.
 *
 * Kinds NOT submitted are left untouched on purpose. A passphrase change
 * re-wraps only `passphrase`; the `recovery` record still wraps the SAME
 * (unchanged) DEK and stays valid, so touching it would destroy a working
 * recovery path for nothing.
 */
async function upsertKeyRecords(
  tx: Transaction,
  input: { accountId: number; keyRecords: KeyRecordSubmission[]; updatedAt: Date },
): Promise<void> {
  for (const record of input.keyRecords) {
    await tx
      .insert(syncKeyRecords)
      .values({
        accountId: input.accountId,
        kind: record.kind,
        kdfDescriptor: record.kdfDescriptor,
        wrappedDek: Buffer.from(record.wrappedDek),
      })
      .onConflictDoUpdate({
        target: [syncKeyRecords.accountId, syncKeyRecords.kind],
        set: {
          kdfDescriptor: record.kdfDescriptor,
          wrappedDek: Buffer.from(record.wrappedDek),
          updatedAt: input.updatedAt,
        },
      });
  }
}

/** Revokes every live session for one account. Transaction-scoped, for the same reason {@link upsertKeyRecords} is. */
async function revokeSessionsIn(tx: Transaction, input: { accountId: number; revokedAt: Date }): Promise<void> {
  await tx
    .update(accountTokens)
    .set({ revokedAt: input.revokedAt })
    .where(
      and(
        eq(accountTokens.accountId, input.accountId),
        inArray(accountTokens.kind, [...SESSION_TOKEN_KINDS]),
        isNull(accountTokens.revokedAt),
      ),
    );
}

/**
 * Inserts the account row, translating the unique-handle violation into the
 * refusal signal.
 *
 * IT HAS TO THROW rather than return, because it runs inside the transaction
 * that has already claimed an invite. Returning would commit that claim and
 * charge somebody their invitation for a handle collision; throwing rolls it
 * back and leaves the invite spendable, which is what PROTOCOL.md §5.8.1
 * promises.
 */
async function insertAccountRow(tx: Transaction, input: CreateAccountInput): Promise<AccountRow[]> {
  try {
    return await tx
      .insert(accounts)
      .values({
        handle: input.handle,
        displayName: input.displayName,
        verifier: input.verifier,
        recoveryVerifier: input.recoveryVerifier,
        kdfDescriptor: input.kdfDescriptor,
      })
      .returning();
  } catch (error) {
    // The unique index on `handle` is what makes concurrent signups for
    // the same handle safe, never a read-then-insert check.
    if (!isUniqueViolation(error)) throw error;
    throw new AccountCreationRefused({ ok: false, reason: 'handle-taken' });
  }
}

/**
 * Spends the presented admission, inside the caller's transaction.
 *
 * @returns the id of the invite that was claimed, or `null` for the bootstrap
 *   branch, which has no row to stamp afterwards.
 * @throws AccountCreationRefused when the admission is not spendable. Every
 *   cause produces the ONE `not-admitted` reason: which of them it was is
 *   information the caller must not be able to publish.
 */
async function claimAdmission(
  tx: Transaction,
  input: { admission: AccountAdmission; now: Date },
): Promise<number | null> {
  if (input.admission.kind === 'bootstrap') {
    // Serialised against every other bootstrap signup. See
    // {@link BOOTSTRAP_ADVISORY_LOCK_LABEL} for why a row lock cannot do this.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${BOOTSTRAP_ADVISORY_LOCK_LABEL}))`);
    const [existing] = await tx.select({ value: count() }).from(accounts);
    if (Number(existing?.value ?? 0) !== 0) {
      // The token is self-invalidating: one account exists, so this branch is
      // dead for the rest of the instance's life (ADR-0009).
      throw new AccountCreationRefused({ ok: false, reason: 'not-admitted' });
    }
    return null;
  }

  // ONE conditional UPDATE, not a SELECT then an UPDATE. It takes the row lock
  // and re-evaluates its own WHERE clause after waiting for whoever held it, so
  // two concurrent redemptions of one token produce one winner and one empty
  // result set. A read-then-write would let both read `redeemed_at IS NULL`.
  //
  // A NULL `expires_at` means "never expires", not "expired", and the two readings
  // are one comparison apart and the wrong one opens or closes the gate for
  // every invite ever minted without a lifetime (see the column doc).
  const claimed = await tx
    .update(invites)
    .set({ redeemedAt: input.now })
    .where(
      and(
        eq(invites.tokenHash, input.admission.tokenHash),
        isNull(invites.redeemedAt),
        or(isNull(invites.expiresAt), gt(invites.expiresAt, input.now)),
      ),
    )
    .returning({ id: invites.id });

  const claimedId = claimed[0]?.id;
  // Unknown, already redeemed and expired are indistinguishable from here on,
  // and that is the point: this branch cannot tell them apart either.
  if (claimedId === undefined) throw new AccountCreationRefused({ ok: false, reason: 'not-admitted' });
  return claimedId;
}

/**
 * @param db The Drizzle handle. Defaults to the raw one, which is what the
 *   application always wants; the parameter exists so an integration test can
 *   hand in a handle bound to its own database.
 * @returns the store the auth handlers are written against.
 */
export function createDrizzleAccountStore(db: Database = getRawDb()): AccountStore {
  return {
    async findAccountByHandle(handle: string): Promise<AccountRecord | null> {
      const [row] = await db.select().from(accounts).where(eq(accounts.handle, handle)).limit(1);
      return row ? mapAccountRow(row) : null;
    },

    async findAccountById(accountId: number): Promise<AccountRecord | null> {
      const [row] = await db.select().from(accounts).where(eq(accounts.id, accountId)).limit(1);
      return row ? mapAccountRow(row) : null;
    },

    async createAccount(input: CreateAccountInput): Promise<CreateAccountResult> {
      const now = new Date();
      try {
        return await db.transaction(async (tx) => {
          // ADMISSION FIRST, and the whole transaction exists for this ordering
          // (see `AccountStore.createAccount`). An uninvited caller never
          // reaches the insert, so it never reaches the `409` either.
          const claimedInviteId = await claimAdmission(tx, { admission: input.admission, now });

          const [row] = await insertAccountRow(tx, input);
          if (!row) throw new Error('Failed to insert account');

          // The audit half of the redemption. `redeemedAt` was already stamped
          // by the claim above, because THAT is the authoritative spent marker
          // (see the column doc): this reference is `ON DELETE SET NULL`, and a
          // spent marker that can return to NULL when an account is deleted
          // would hand a used token a second life.
          if (claimedInviteId !== null) {
            await tx.update(invites).set({ redeemedByAccountId: row.id }).where(eq(invites.id, claimedInviteId));
          }

          return { ok: true, account: mapAccountRow(row) };
        });
      } catch (error) {
        if (error instanceof AccountCreationRefused) return error.result;
        throw error;
      }
    },

    async deleteAccount(accountId: number): Promise<void> {
      await db.delete(accounts).where(eq(accounts.id, accountId));
    },

    async insertTokens(tokens: NewTokenInput[]): Promise<void> {
      if (tokens.length === 0) return;
      await db.insert(accountTokens).values(tokenValues(tokens));
    },

    async findToken(input: { kind: AccountTokenKind; tokenHash: string }): Promise<StoredToken | null> {
      const [row] = await db
        .select()
        .from(accountTokens)
        .where(and(eq(accountTokens.tokenHash, input.tokenHash), eq(accountTokens.kind, input.kind)))
        .limit(1);
      return row ? mapTokenRow(row) : null;
    },

    async revokeToken(input: { tokenId: number; revokedAt: Date }): Promise<void> {
      // `isNull` guard: revocation is stamped once, so a re-revoked token keeps
      // the instant it was actually invalidated.
      await db
        .update(accountTokens)
        .set({ revokedAt: input.revokedAt })
        .where(and(eq(accountTokens.id, input.tokenId), isNull(accountTokens.revokedAt)));
    },

    async revokeFamily(input: { accountId: number; familyId: string; revokedAt: Date }): Promise<void> {
      await db
        .update(accountTokens)
        .set({ revokedAt: input.revokedAt })
        .where(
          and(
            eq(accountTokens.accountId, input.accountId),
            eq(accountTokens.familyId, input.familyId),
            isNull(accountTokens.revokedAt),
          ),
        );
    },

    async revokeSessions(input: { accountId: number; revokedAt: Date }): Promise<void> {
      await db
        .update(accountTokens)
        .set({ revokedAt: input.revokedAt })
        .where(
          and(
            eq(accountTokens.accountId, input.accountId),
            inArray(accountTokens.kind, [...SESSION_TOKEN_KINDS]),
            isNull(accountTokens.revokedAt),
          ),
        );
    },

    async rotateCredential(input: RotateCredentialInput): Promise<void> {
      await db.transaction(async (tx) => {
        await tx
          .update(accounts)
          .set({ verifier: input.verifier, kdfDescriptor: input.kdfDescriptor })
          .where(eq(accounts.id, input.accountId));

        await upsertKeyRecords(tx, {
          accountId: input.accountId,
          keyRecords: input.keyRecords,
          updatedAt: input.revokedAt,
        });

        // Every other device is logged out. A user changing their passphrase
        // under suspicion expects exactly this.
        await revokeSessionsIn(tx, { accountId: input.accountId, revokedAt: input.revokedAt });

        if (input.issue.length > 0) {
          await tx.insert(accountTokens).values(tokenValues(input.issue));
        }
      });
    },

    async recoverAndRotatePassphrase(
      input: RecoverAndRotatePassphraseInput,
    ): Promise<RecoverAndRotatePassphraseResult> {
      // ONE transaction, and the four writes below are the whole reason this
      // method exists rather than a handler calling the store four times. See
      // `AccountStore.recoverAndRotatePassphrase` for what each half-state
      // costs the user; none of them is recoverable and none is visible until
      // they try to read their own diary.
      try {
        return await db.transaction(async (tx): Promise<RecoverAndRotatePassphraseResult> => {
          // (1) and (2): the passphrase verifier and, when the user is also
          // replacing their code, the recovery verifier — in one UPDATE, guarded
          // by the recovery verifier the handler matched. Zero rows means
          // another rotation committed in between, so this one is operating on a
          // credential that no longer exists and must not proceed.
          const [updated] = await tx
            .update(accounts)
            .set({
              verifier: input.verifier,
              kdfDescriptor: input.kdfDescriptor,
              // `undefined` omits the column from the SET list, which is how a
              // rotation that keeps the existing code leaves it alone. `null`
              // would CLEAR it and silently destroy the second authenticator.
              recoveryVerifier: input.newRecoveryVerifier ?? undefined,
            })
            .where(and(eq(accounts.id, input.accountId), eq(accounts.recoveryVerifier, input.expectedRecoveryVerifier)))
            .returning({ id: accounts.id });

          if (!updated) throw new RecoveryRotationRefused({ ok: false, reason: 'recovery-superseded' });

          // (3) and (4): the re-wrapped `passphrase` record, and the `recovery`
          // record when the code itself moved. Same statement as an ordinary
          // change-passphrase, inside this transaction.
          await upsertKeyRecords(tx, {
            accountId: input.accountId,
            keyRecords: input.keyRecords,
            updatedAt: input.revokedAt,
          });

          // A recovery is a stronger event than a passphrase change: whoever
          // held the old passphrase is, by construction, not the person doing
          // this. Every outstanding session goes.
          await revokeSessionsIn(tx, { accountId: input.accountId, revokedAt: input.revokedAt });

          if (input.issue.length > 0) {
            await tx.insert(accountTokens).values(tokenValues(input.issue));
          }

          return { ok: true };
        });
      } catch (error) {
        if (error instanceof RecoveryRotationRefused) return error.result;
        throw error;
      }
    },

    async purgeExpiredTokens(input: { before: Date }): Promise<number> {
      const rows = await db
        .delete(accountTokens)
        .where(lt(accountTokens.expiresAt, input.before))
        .returning({ id: accountTokens.id });
      return rows.length;
    },
  };
}
