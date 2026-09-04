/**
 * The account model: `users` and `user_tokens`.
 *
 * A PLAIN ACCOUNT, ON PURPOSE (M191). This file replaces
 * `drizzle/schema/accounts.ts`, which carried an opaque handle, a verifier, a
 * recovery verifier and an Argon2id descriptor, because the personal data it
 * guarded was sealed and the server held no key for it. That bar cost the only
 * real reader an address, a way back in, and a name they had chosen. The blob
 * is plain JSON now (`drizzle/schema/sync.ts`), so the honest account is the
 * ordinary one: an email address, a password, a mailed link to confirm the
 * first and a mailed link to replace the second.
 *
 * EVERY READ OR WRITE GOES THROUGH `getRawDb()`.
 */
import { relations, type InferInsertModel, type InferSelectModel } from 'drizzle-orm';
import { boolean, index, integer, pgTable, serial, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';

/** The two single-use link kinds. A token is minted for exactly one of them and spent once. */
export type UserTokenKind = 'verify' | 'reset';

// =============================================================================
// Users
// =============================================================================

export const users = pgTable(
  'users',
  {
    id: serial('id').primaryKey(),
    /**
     * The address, stored trimmed and lower-cased by
     * `app/lib/auth/email.ts`'s `normalizeEmail`, which is the ONLY function
     * allowed to write this column's form. The unique index below is over that
     * form, so it is a true case-insensitive uniqueness guarantee and it is
     * also what makes two concurrent signups for the same address safe: never
     * a read-then-insert check.
     */
    email: text('email').notNull(),
    /** bcryptjs, cost 10. Never a raw password, and nothing derived from it that a dump could replay. */
    passwordHash: text('password_hash').notNull(),
    /**
     * When the mailed verify link was spent. `NULL` means the address is
     * unconfirmed, and `signIn` refuses an unconfirmed user exactly as it
     * refuses a wrong password: the caller cannot tell the two apart.
     */
    emailVerifiedAt: timestamp('email_verified_at'),
    /**
     * When the password last changed. IT IS THE SESSION EPOCH: the auth
     * middleware drops any cookie issued before this instant, so a reset signs
     * every other device out on its next request without a session table to
     * sweep. Set at signup so the comparison never meets a NULL.
     */
    passwordChangedAt: timestamp('password_changed_at').defaultNow().notNull(),
    /**
     * Whether this user may reach the operator screens under `/super`. Granted
     * out of band by `pnpm cli account grant-superadmin <email>`, never through
     * the application. It is the SCREEN-level flag; the bearer-token surface
     * has its own on the key itself (`api_keys.is_superadmin`), and neither
     * reads the other.
     */
    isSuperadmin: boolean('is_superadmin').default(false).notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at')
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [uniqueIndex('users_email_idx').on(table.email)],
);

export type InsertUser = InferInsertModel<typeof users>;
export type SelectUser = InferSelectModel<typeof users>;

// =============================================================================
// User tokens
// =============================================================================

/**
 * Every single-use link this service mails: the address confirmation and the
 * password reset.
 *
 * ONLY DIGESTS ARE STORED, so a dumped table replays nothing. A row is kept
 * after it is spent rather than deleted, because `used_at` is what turns a
 * second click on the same link into "this link was already used" instead of
 * "no such link", and you cannot report the difference from a row you removed.
 */
export const userTokens = pgTable(
  'user_tokens',
  {
    id: serial('id').primaryKey(),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    kind: text('kind').$type<UserTokenKind>().notNull(),
    /** SHA-256 hex of 32 random bytes. The raw token exists only in the mail that carried it. */
    tokenHash: text('token_hash').notNull(),
    expiresAt: timestamp('expires_at').notNull(),
    /** Set once, never cleared. A spent token is spent for good; a new link is a new row. */
    usedAt: timestamp('used_at'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (table) => [
    // Lookup is always by digest, and a collision across users would be an
    // authentication bypass, so uniqueness here is a security property.
    uniqueIndex('user_tokens_hash_idx').on(table.tokenHash),
    index('user_tokens_user_kind_idx').on(table.userId, table.kind),
    index('user_tokens_expires_idx').on(table.expiresAt),
  ],
);

export type InsertUserToken = InferInsertModel<typeof userTokens>;
export type SelectUserToken = InferSelectModel<typeof userTokens>;

export const usersRelations = relations(users, ({ many }) => ({
  tokens: many(userTokens),
}));

export const userTokensRelations = relations(userTokens, ({ one }) => ({
  user: one(users, { fields: [userTokens.userId], references: [users.id] }),
}));
