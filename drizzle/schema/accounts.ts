/**
 * COPIED, NOT SHARED. Source: openplate-sync/src/db/schema.ts @ 311a1578af3ca169e8a08c6d50d90889e29d5889.
 * See .adr/0008-e2ee-sync-copied-not-extracted.md. Fixes belong upstream first,
 * then here. Do not let the two drift.
 */
/**
 * The end-to-end-encrypted personal layer's four tables: `accounts`,
 * `account_tokens`, `sync_blobs` and `sync_key_records`.
 *
 * EVERY READ OR WRITE GOES THROUGH `getRawDb()`. An account is a person's own
 * identity on this installation, and it belongs to nobody else.
 *
 * There is NO EMAIL COLUMN here, and adding one would undo the decision this
 * file was copied under. Accounts are identified by an opaque `handle`, an
 * `'@'` is refused at the input layer (`app/lib/e2ee/auth-input.ts`), and
 * recovery is a SECOND AUTHENTICATOR (`accounts.recoveryVerifier`) rather than
 * a mailed link. The upstream reasoning is a security argument, not a cleanup:
 * a reset link restored a LOGIN to data that stays sealed, because the server
 * never held a key that unwraps a DEK. See ADR-0008.
 */
import type { JsonObject } from '#app/lib/e2ee/json';
import type { KdfDescriptor } from '#app/lib/e2ee/kdf-descriptor';
import type { AccountTokenKind } from '#app/lib/e2ee/tokens';
import type { SyncKeyRecordKind } from '#app/lib/e2ee/protocol';
import { relations, type InferInsertModel, type InferSelectModel } from 'drizzle-orm';
import {
  boolean,
  customType,
  index,
  integer,
  jsonb,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

/**
 * Raw binary column (Postgres `bytea`). drizzle-orm's `pg-core` has no
 * built-in helper, so this is the documented `customType` pattern. Used for
 * opaque ciphertext only: the service stores and returns these bytes
 * verbatim and never parses them (PROTOCOL.md §10.5).
 */
const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() {
    return 'bytea';
  },
});

// =============================================================================
// Accounts
// =============================================================================

/**
 * DELIBERATELY MINIMAL. An account is an identity plus the material needed to
 * authenticate it — nothing else. There is no profile, no display avatar, no
 * settings blob, because everything a user actually owns lives inside the
 * encrypted material that this service cannot read.
 */
export const accounts = pgTable(
  'accounts',
  {
    id: serial('id').primaryKey(),
    /**
     * The account identifier, and the ONLY thing this service knows that a
     * person chose. An opaque per-server string: the client mints a short one
     * at signup and the user may edit it, the service never generates or
     * suggests one, and an `'@'` is refused at the input layer
     * (`app/lib/e2ee/auth-input.ts`) so this column cannot drift back into
     * being an address register. Stored already-normalized — see the index
     * below.
     */
    handle: text('handle').notNull(),
    /** Optional, cosmetic, and the ONLY non-authentication field here on purpose (see the table doc). */
    displayName: text('display_name'),
    /**
     * `HMAC-SHA-256(serverPepper, clientAuthHash)`, hex — never the auth-hash
     * itself and never anything that can decrypt a blob. See
     * `app/lib/e2ee/verifier.ts` for why this is a fast keyed hash and not a
     * second slow KDF.
     */
    verifier: text('verifier').notNull(),
    /**
     * The SECOND authenticator: `HMAC-SHA-256(serverPepper,
     * clientRecoveryAuthHash)`, hex, computed by the very same
     * `app/lib/e2ee/verifier.ts` `computeVerifier` as the column above. Never
     * the raw hash, and never anything that opens a blob.
     *
     * THE CLIENT DERIVES ITS INPUT UNDER A LABEL THAT IS NOT THE RECOVERY-KEK
     * LABEL, and that separation is the whole security argument for this
     * column. `openplate-sync:recovery-auth:v1` is a sibling of
     * `openplate-sync:recovery-kek:v1`: both are HKDF branches over the raw
     * recovery code, and the KEK branch is what WRAPS the account's DEK. Were
     * the same output used for both, this service would be storing an HMAC of
     * the material that opens the diary, and "the operator cannot read your
     * data" would rest on SHA-256 being one-way rather than on the operator
     * never having held the value at all. Domain separation is what keeps the
     * claim structural.
     *
     * NULLABLE, because an account may be created without one. A `NULL` here
     * means the account has no second authenticator: a lost passphrase is then
     * terminal, which is stated plainly rather than papered over.
     */
    recoveryVerifier: text('recovery_verifier'),
    /**
     * Argon2id salt + cost parameters, served UNAUTHENTICATED to a new device
     * before login (PROTOCOL.md §5.7). Non-secret by construction — a salt
     * that has to be handed out cannot be a secret, and cost parameters are
     * published in the protocol anyway.
     */
    kdfDescriptor: jsonb('kdf_descriptor').$type<KdfDescriptor>().notNull(),
    /**
     * NOT UPSTREAM — this column exists only in this repo.
     *
     * It replaces the `users.is_superadmin` check for this app's admin routes.
     * Authentication moves onto `accounts`, so the flag that decides who may
     * reach an admin surface has to move with it; leaving it on `users` would
     * mean an account could authenticate and then be authorised against a row
     * it has no relation to. Granted out of band by
     * `pnpm cli account grant-superadmin <handle>`, never through the API.
     */
    isSuperadmin: boolean('is_superadmin').default(false).notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at')
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  // Handles are stored already-normalized (`app/lib/e2ee/verifier.ts`'s
  // `normalizeHandle`: NFKC, trim, lowercase), so a plain unique index is a
  // true case-insensitive AND Unicode-form-insensitive uniqueness guarantee.
  // This index is also what makes concurrent signups for the same handle safe
  // — never a read-then-insert check.
  (table) => [uniqueIndex('accounts_handle_idx').on(table.handle)],
);

export type InsertAccount = InferInsertModel<typeof accounts>;
export type SelectAccount = InferSelectModel<typeof accounts>;

// =============================================================================
// Account tokens
// =============================================================================

/**
 * Every opaque token this service issues. That is session pairs and nothing
 * else: the two single-use link kinds went with the mailer upstream
 * (`app/lib/e2ee/tokens.ts` owns the kinds and their TTLs).
 *
 * Only digests are stored, so this table is not replayable if dumped. Rows
 * are retained after revocation rather than deleted: a presented-but-revoked
 * refresh token is the reuse signal that revokes its whole family, and you
 * cannot detect reuse of a row you deleted.
 */
export const accountTokens = pgTable(
  'account_tokens',
  {
    id: serial('id').primaryKey(),
    accountId: integer('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    kind: text('kind').$type<AccountTokenKind>().notNull(),
    /** SHA-256 hex of the raw token. The raw value exists only in the client's memory. */
    tokenHash: text('token_hash').notNull(),
    /**
     * Links an access token to the refresh token that minted it, and survives
     * rotation. `logout` revokes one family (one device); reuse detection
     * revokes the family of a replayed refresh token. Nullable because the
     * column outlived the link tokens, which had no lineage; every row written
     * today carries one.
     */
    familyId: text('family_id'),
    expiresAt: timestamp('expires_at').notNull(),
    /** Set once, never cleared. Revocation is permanent — a re-login mints new rows. */
    revokedAt: timestamp('revoked_at'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (table) => [
    // Lookup is always by digest, and a digest collision across accounts would
    // be an authentication bypass — so uniqueness here is a security property,
    // not an optimization.
    uniqueIndex('account_tokens_hash_idx').on(table.tokenHash),
    index('account_tokens_account_kind_idx').on(table.accountId, table.kind),
    index('account_tokens_family_idx').on(table.familyId),
    // Supports the periodic sweep of long-dead rows.
    index('account_tokens_expires_idx').on(table.expiresAt),
  ],
);

export type InsertAccountToken = InferInsertModel<typeof accountTokens>;
export type SelectAccountToken = InferSelectModel<typeof accountTokens>;

// =============================================================================
// Sync blobs
// =============================================================================

export const syncBlobs = pgTable(
  'sync_blobs',
  {
    id: serial('id').primaryKey(),
    /**
     * `onDelete: 'cascade'` is the self-serve DSAR mechanism: deleting an
     * account removes every blob it ever pushed in the same statement, with
     * no cleanup job to forget to run and no window where orphaned ciphertext
     * survives its owner. This closed the M118 privacy blocker.
     */
    accountId: integer('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    /**
     * Monotonic per-account version — the CAS token (PROTOCOL.md §5.1). A
     * push is accepted only when its `baseVersion` equals the current max;
     * a stale push is a `409`, never a blind overwrite that would silently
     * discard another device's unsynced changes.
     */
    blobVersion: integer('blob_version').notNull(),
    /** The envelope's wire-format version (`ENVELOPE_VERSION`), independent of the payload's own schema version. */
    envelopeVersion: integer('envelope_version').notNull(),
    /** Opaque ciphertext: `iv ‖ AES-256-GCM(...)` as one packed blob. The service never parses it and holds no key for it. */
    ciphertext: bytea('ciphertext').notNull(),
    /** Redundant with `ciphertext`'s length, but avoids reading a 2 MiB blob just to report storage usage. */
    sizeBytes: integer('size_bytes').notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (table) => [
    // The CAS guarantee itself: two concurrent pushes off the same
    // `baseVersion` can both pass the read, but only one INSERT of the same
    // (account, version) pair can survive. Retention (N=5) is enforced by the
    // adapter's prune step — Postgres has no native "keep last N rows" rule.
    uniqueIndex('sync_blobs_account_version_idx').on(table.accountId, table.blobVersion),
    index('sync_blobs_account_idx').on(table.accountId),
  ],
);

export type InsertSyncBlob = InferInsertModel<typeof syncBlobs>;
export type SelectSyncBlob = InferSelectModel<typeof syncBlobs>;

// =============================================================================
// Sync key records
// =============================================================================

export const syncKeyRecords = pgTable(
  'sync_key_records',
  {
    id: serial('id').primaryKey(),
    accountId: integer('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    /** Which KEK this record wraps the account's DEK under — `passphrase` or `recovery`. */
    kind: text('kind').$type<SyncKeyRecordKind>().notNull(),
    /** Argon2id salt + params for the `passphrase` kind; NULL for `recovery` (HKDF-only, nothing to record). */
    kdfDescriptor: jsonb('kdf_descriptor').$type<JsonObject>(),
    /** The account's DEK wrapped under this record's KEK, one packed `iv ‖ ciphertext‖tag` blob. Never unwrapped here. */
    wrappedDek: bytea('wrapped_dek').notNull(),
    /**
     * MILLISECOND precision, deliberately — `timestamp(3)`, not the `timestamp(6)`
     * a bare `timestamp()` gives you. Kept identical to `updatedAt` below so the
     * two are comparable; see that column for the whole reason.
     */
    createdAt: timestamp('created_at', { precision: 3 }).defaultNow().notNull(),
    /**
     * Also this row's CAS token: `PUT /v1/sync/key-records/:kind` requires the
     * caller's `expectedUpdatedAt` to match exactly (or be `null`, asserting
     * no row exists yet) before a write is accepted.
     *
     * MILLISECOND precision is therefore LOAD-BEARING, not cosmetic. The token
     * leaves here as an ISO-8601 string, which carries milliseconds; Postgres's
     * `now()` carries MICROSECONDS. While this column was a bare `timestamp`
     * (= `timestamp(6)`) an INSERT that let `defaultNow()` supply the value
     * stored a µs tail the wire could not express, so the token a client read
     * back was a truncation of the stored value and the exact-equality CAS
     * matched zero rows — every rotation 409'd forever (M160 spec 06).
     *
     * Declaring the precision fixes the CLASS rather than the instance: the
     * database now refuses to hold anything the protocol cannot round-trip, so
     * the next writer who reaches for `defaultNow()` here cannot reintroduce
     * the trap.
     */
    updatedAt: timestamp('updated_at', { precision: 3 })
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [uniqueIndex('sync_key_records_account_kind_idx').on(table.accountId, table.kind)],
);

export type InsertSyncKeyRecord = InferInsertModel<typeof syncKeyRecords>;
export type SelectSyncKeyRecord = InferSelectModel<typeof syncKeyRecords>;

// =============================================================================
// Relations
// =============================================================================

export const accountsRelations = relations(accounts, ({ many }) => ({
  tokens: many(accountTokens),
  blobs: many(syncBlobs),
  keyRecords: many(syncKeyRecords),
}));

export const syncBlobsRelations = relations(syncBlobs, ({ one }) => ({
  account: one(accounts, { fields: [syncBlobs.accountId], references: [accounts.id] }),
}));

export const accountTokensRelations = relations(accountTokens, ({ one }) => ({
  account: one(accounts, { fields: [accountTokens.accountId], references: [accounts.id] }),
}));

export const syncKeyRecordsRelations = relations(syncKeyRecords, ({ one }) => ({
  account: one(accounts, { fields: [syncKeyRecords.accountId], references: [accounts.id] }),
}));
