/**
 * Signup invites: the one table that decides who may create an account here.
 *
 * NOT COPIED. `openplate-sync` gates its own signups, but this table and its
 * columns are this app's decision (ADR-0009), so there is no provenance header
 * and no upstream file to keep it in step with.
 *
 * GLOBAL, NOT TENANT-SCOPED, for the same reason `accounts` is: an invite
 * admits a person to this installation, it is not a row inside somebody's
 * organization. It carries no `organizationId`, it does not belong in
 * `TENANT_TABLES` in `drizzle/tenant-db.ts`, and every read or write goes
 * through `getRawDb()`.
 *
 * THERE IS NO PLAINTEXT TOKEN COLUMN, and adding one would undo the point of
 * the table. What is stored is `HMAC-SHA-256(inviteTokenPepper, token)`, hex,
 * computed by `app/lib/invites/token.ts`; the plaintext is printed once by
 * `pnpm cli account invite` and then exists nowhere on this installation.
 * That mirrors `accounts.verifier`: a dumped database yields nothing that can
 * be replayed against a live instance.
 *
 * NO EMAIL COLUMN EITHER, and for the reason `schema/accounts.ts` spells out
 * at length: this service holds no addresses. An invite is a bearer token
 * handed to a person out of band, exactly like openplate's join link. Who it
 * was for is the minter's business, not this table's.
 */
import { relations, type InferInsertModel, type InferSelectModel } from 'drizzle-orm';
import { index, integer, pgTable, serial, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { accounts } from './accounts';

export const invites = pgTable(
  'invites',
  {
    id: serial('id').primaryKey(),
    /**
     * `HMAC-SHA-256(inviteTokenPepper, token)`, hex. The lookup key AND the
     * whole stored secret, see the table doc for why the plaintext is absent.
     */
    tokenHash: text('token_hash').notNull(),
    /**
     * The superadmin who minted this invite.
     *
     * NULLABLE, and the null is load-bearing rather than lazy: the FIRST
     * invites on an installation are minted by an operator at a shell prompt
     * (`pnpm cli account invite`) at a moment when `accounts` may still be
     * empty, so there is no account row to attribute them to. A null here
     * reads "minted out of band by the operator", which is exactly what
     * happened.
     *
     * `onDelete: 'set null'` rather than `cascade`: deleting the minter's
     * account must not silently delete the audit trail of invites they handed
     * out, some of which may already be redeemed by other people.
     */
    mintedByAccountId: integer('minted_by_account_id').references(() => accounts.id, {
      onDelete: 'set null',
    }),
    /**
     * The account this invite created, once it has been redeemed. NULL means
     * unredeemed.
     *
     * `onDelete: 'set null'` again, deliberately NOT `cascade`: a redeemed
     * invite whose account is later deleted must stay redeemed. Cascading
     * would delete the row and hand the same invite token a second life, which
     * is the one thing a single-use credential must never get.
     */
    redeemedByAccountId: integer('redeemed_by_account_id').references(() => accounts.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    /**
     * Set once, at redemption, and never cleared. This column, not
     * `redeemedByAccountId`, is the authoritative "spent" marker, because the
     * account reference above can legitimately return to NULL when an account
     * is deleted. A redemption check that read the reference would resurrect
     * the token; one that reads this timestamp cannot.
     */
    redeemedAt: timestamp('redeemed_at'),
    /**
     * NULLABLE, and a NULL means "never expires" rather than "expired".
     * Stated here because the two readings are one inverted comparison apart
     * and the wrong one silently opens or closes the gate for every invite
     * ever minted without an explicit lifetime.
     */
    expiresAt: timestamp('expires_at'),
  },
  (table) => [
    // Lookup is always by hash, and a collision across two invites would let
    // one token redeem another's row, so uniqueness here is a security
    // property and not an optimization. It is also what makes two concurrent
    // redemptions of the same token safe without a read-then-write check.
    uniqueIndex('invites_token_hash_idx').on(table.tokenHash),
    // Supports the operator listing what is still outstanding.
    index('invites_redeemed_at_idx').on(table.redeemedAt),
  ],
);

export type InsertInvite = InferInsertModel<typeof invites>;
export type SelectInvite = InferSelectModel<typeof invites>;

// No inverse `many(invites)` is declared on `accounts`: that file is a copied
// one (ADR-0008) and an invite is not part of the upstream account model.
// Without an inverse there is no ambiguity between these two references, so
// neither needs a `relationName`.
export const invitesRelations = relations(invites, ({ one }) => ({
  mintedBy: one(accounts, {
    fields: [invites.mintedByAccountId],
    references: [accounts.id],
  }),
  redeemedBy: one(accounts, {
    fields: [invites.redeemedByAccountId],
    references: [accounts.id],
  }),
}));
