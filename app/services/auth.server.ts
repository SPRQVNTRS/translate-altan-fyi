/**
 * The server half of the account: register, confirm, sign in, reset, change,
 * delete.
 *
 * ── It never says which half of a credential was wrong ────────────────────
 *
 * {@link signIn} answers `null` for an unknown address, a wrong password and an
 * unconfirmed address alike, and {@link registerUser} and
 * {@link requestPasswordReset} answer the same way whether or not the address
 * is on file. Every one of those is a decision made HERE rather than in a
 * screen, because an enumeration oracle is built by the one caller that forgets
 * to be careful. What a screen may say is fixed by what this module returns.
 *
 * ── A token is consumed in one statement ──────────────────────────────────
 *
 * Confirming an address and spending a reset link are a single UPDATE with the
 * "unused and unexpired" test in the WHERE clause and `RETURNING user_id`.
 * Zero rows means used, expired or unknown, and the three are indistinguishable
 * on purpose. A read-then-write pair here would let two clicks on the same link
 * both pass the read, which for a reset link means two different new passwords
 * both being accepted.
 *
 * ── A password change is a session epoch ──────────────────────────────────
 *
 * {@link changePassword} and {@link resetPassword} bump
 * `users.password_changed_at` and hand back a FRESH session cookie, so the tab
 * that made the change stays signed in and every other session dies on its next
 * request (`app/middleware/auth.ts` compares the cookie's `issuedAt` against
 * that column). There is no session table to sweep and nothing to get out of
 * step.
 */
import bcrypt from 'bcryptjs';
import { and, eq, isNull, sql } from 'drizzle-orm';
import type { TFunction } from 'i18next';

import { getRawDb } from '#drizzle/db';
import { users, userTokens, type SelectUser, type UserTokenKind } from '#drizzle/schema';
import { normalizeEmail } from '#app/lib/auth/email';
import { isAcceptablePassword } from '#app/lib/auth/password-rule';
import { buildTokenUrl, expiryFor, generateToken, hashToken } from '#app/lib/auth/tokens';
import { resetPasswordTemplate } from '#app/emails/reset-password';
import { verifyEmailTemplate } from '#app/emails/verify-email';
import { sendMail } from '#app/services/email.server';
import { createComponentLogger } from '#app/lib/logger';
import { commitUserSession } from '#app/services/session.server';

const log = createComponentLogger('Auth');

/** bcryptjs work factor. Ten is the reference implementation's, and it is what the stored hashes are written with. */
const BCRYPT_COST = 10;

/** Where the two mailed links land. */
const VERIFY_PATH = '/verify-email';
const RESET_PATH = '/reset-password';

/**
 * What a mail needs that this module cannot know: the language to write in and
 * the origin to build an absolute link against.
 *
 * BOTH COME FROM THE REQUEST, never from module state. A process-wide i18next
 * instance would render one reader's mail in another reader's language, which
 * is the same trap `app/i18n/meta-title.ts` documents for page titles.
 */
export interface MailContext {
  t: TFunction;
  /** For example `https://translate.altan.fyi`. Taken from the request URL by the caller. */
  origin: string;
}

/** The uniform answer to "make an account" and "send me a reset link". It never says whether the address was known. */
export type MailedResult = { status: 'mailed' };

/** What {@link registerUser} refuses outright, which is only ever the caller's own input. */
export type RegisterResult = MailedResult | { status: 'invalid-password' };

/** The outcome of spending a mailed link. */
export type ConsumeResult = { status: 'ok'; userId: number } | { status: 'invalid' };

/** The outcome of setting a new password from a reset link. */
export type ResetResult =
  | { status: 'ok'; userId: number; setCookie: string }
  | { status: 'invalid-token' }
  | { status: 'invalid-password' };

/** The outcome of changing a password while signed in. */
export type ChangeResult = { status: 'ok'; setCookie: string } | { status: 'wrong-password' } | { status: 'invalid-password' };

/**
 * Creates an account and mails the confirmation link.
 *
 * IT ANSWERS `mailed` FOR AN ADDRESS THAT IS ALREADY ON FILE. An unconfirmed
 * one is mailed a fresh link, which is the useful behaviour for the reader who
 * lost the first mail; a confirmed one is mailed nothing at all, and the screen
 * says the same sentence either way. The only refusal is a password this
 * installation will not accept, which is the caller's own input and reveals
 * nothing about anybody else.
 *
 * @param input.email the address as typed.
 * @param input.password the password as typed.
 * @param input.mail the language and origin for the confirmation mail.
 * @returns `mailed`, or `invalid-password` for a password under the floor.
 */
export async function registerUser(input: { email: string; password: string; mail: MailContext }): Promise<RegisterResult> {
  if (!isAcceptablePassword(input.password)) return { status: 'invalid-password' };

  const email = normalizeEmail(input.email);
  const db = getRawDb();
  const existing = await db.query.users.findFirst({ where: eq(users.email, email) });

  if (existing) {
    // Already confirmed: nothing to send, and nothing to say that the screen
    // does not already say to a stranger.
    if (existing.emailVerifiedAt !== null) return { status: 'mailed' };
    await mailVerification({ user: existing, mail: input.mail });
    return { status: 'mailed' };
  }

  const [created] = await db
    .insert(users)
    .values({ email, passwordHash: await bcrypt.hash(input.password, BCRYPT_COST) })
    .returning();
  if (!created) throw new Error('Could not create the user row.');

  await mailVerification({ user: created, mail: input.mail });
  return { status: 'mailed' };
}

/**
 * Mails a fresh confirmation link to an address that has not confirmed one.
 *
 * Same non-disclosure contract as {@link registerUser}: a confirmed address and
 * an unknown one both answer `mailed` and receive nothing.
 *
 * @param input.email the address as typed.
 * @param input.mail the language and origin for the mail.
 * @returns `mailed`, always.
 */
export async function resendVerification(input: { email: string; mail: MailContext }): Promise<MailedResult> {
  const user = await getRawDb().query.users.findFirst({ where: eq(users.email, normalizeEmail(input.email)) });
  if (user && user.emailVerifiedAt === null) await mailVerification({ user, mail: input.mail });
  return { status: 'mailed' };
}

/**
 * Spends a confirmation link and marks the address confirmed.
 *
 * @param rawToken the token from the URL.
 * @returns the confirmed user's id, or `invalid` for a token that is used,
 *   expired or unknown.
 */
export async function verifyEmailToken(rawToken: string): Promise<ConsumeResult> {
  const consumed = await consumeToken({ rawToken, kind: 'verify' });
  if (consumed.status !== 'ok') return consumed;

  await getRawDb()
    .update(users)
    .set({ emailVerifiedAt: sql`now()` })
    .where(and(eq(users.id, consumed.userId), isNull(users.emailVerifiedAt)));
  return consumed;
}

/**
 * The user behind an address and password, or `null`.
 *
 * THE THREE REFUSALS ARE ONE ANSWER. An unknown address, a wrong password and
 * an unconfirmed address all return `null`, so a caller cannot turn this
 * function into an oracle even by accident. The bcrypt comparison runs even
 * when there is no row, so the two paths cost the same wall-clock time.
 *
 * @param input.email the address as typed.
 * @param input.password the password as typed.
 * @returns the user row, or `null`.
 */
export async function signIn(input: { email: string; password: string }): Promise<SelectUser | null> {
  const user = await getRawDb().query.users.findFirst({ where: eq(users.email, normalizeEmail(input.email)) });

  // A DUMMY COMPARISON FOR AN UNKNOWN ADDRESS, so the answer takes the same
  // time either way. Without it, "no such user" returns in microseconds and
  // "wrong password" in ~80ms, which is an enumeration oracle with a stopwatch.
  const hash = user?.passwordHash ?? DUMMY_HASH;
  const matches = await bcrypt.compare(input.password, hash);

  if (!user || !matches) return null;
  if (user.emailVerifiedAt === null) return null;
  return user;
}

/**
 * Mails a reset link, if the address is on file and confirmed.
 *
 * @param input.email the address as typed.
 * @param input.mail the language and origin for the mail.
 * @returns `mailed`, always, whether or not anything was sent.
 */
export async function requestPasswordReset(input: { email: string; mail: MailContext }): Promise<MailedResult> {
  const user = await getRawDb().query.users.findFirst({ where: eq(users.email, normalizeEmail(input.email)) });
  if (!user || user.emailVerifiedAt === null) return { status: 'mailed' };

  const token = await mintToken({ userId: user.id, kind: 'reset' });
  const url = buildTokenUrl({ origin: input.mail.origin, path: RESET_PATH, token });
  const message = resetPasswordTemplate(input.mail.t, { url });
  await sendMail({ to: user.email, subject: message.subject, text: message.text });
  return { status: 'mailed' };
}

/**
 * Spends a reset link, sets the new password, and hands back a fresh session.
 *
 * THE RETURNED COOKIE IS WHY THE CHANGING TAB SURVIVES. Bumping
 * `password_changed_at` invalidates every session issued earlier, this one
 * included, so the caller must set the cookie this function returns or it signs
 * the reader out of the browser they just proved themselves in.
 *
 * @param input.rawToken the token from the URL.
 * @param input.password the new password as typed.
 * @param input.request the incoming request, for the cookie this returns.
 * @returns the user id and a `Set-Cookie` value, or a refusal.
 */
export async function resetPassword(input: {
  rawToken: string;
  password: string;
  request: Request;
}): Promise<ResetResult> {
  if (!isAcceptablePassword(input.password)) return { status: 'invalid-password' };

  const consumed = await consumeToken({ rawToken: input.rawToken, kind: 'reset' });
  if (consumed.status !== 'ok') return { status: 'invalid-token' };

  const issuedAt = await writeNewPassword({ userId: consumed.userId, password: input.password });
  const setCookie = await commitUserSession({ request: input.request, userId: consumed.userId, issuedAt });
  return { status: 'ok', userId: consumed.userId, setCookie };
}

/**
 * Replaces a signed-in user's password, keeping this browser signed in.
 *
 * @param input.userId the signed-in user.
 * @param input.current the current password, as typed.
 * @param input.next the new password, as typed.
 * @param input.request the incoming request, for the cookie this returns.
 * @returns a `Set-Cookie` value, or a refusal.
 */
export async function changePassword(input: {
  userId: number;
  current: string;
  next: string;
  request: Request;
}): Promise<ChangeResult> {
  if (!isAcceptablePassword(input.next)) return { status: 'invalid-password' };

  const user = await getRawDb().query.users.findFirst({ where: eq(users.id, input.userId) });
  if (!user || !(await bcrypt.compare(input.current, user.passwordHash))) return { status: 'wrong-password' };

  const issuedAt = await writeNewPassword({ userId: input.userId, password: input.next });
  const setCookie = await commitUserSession({ request: input.request, userId: input.userId, issuedAt });
  return { status: 'ok', setCookie };
}

/**
 * Removes a user and everything hanging off them.
 *
 * ONE STATEMENT, and that is the erasure guarantee: `user_tokens` and
 * `sync_blobs` both cascade, so there is no cleanup job to forget to run and no
 * window in which an orphaned document survives its owner.
 *
 * @param userId the user to remove.
 */
export async function deleteUser(userId: number): Promise<void> {
  await getRawDb().delete(users).where(eq(users.id, userId));
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/**
 * A bcrypt hash of a value nobody holds, compared against when no user row
 * exists. Generated once at module load rather than written as a literal, so it
 * cannot be recognised in a source dump as "the unknown-user branch".
 */
const DUMMY_HASH = bcrypt.hashSync('this password authenticates nobody', BCRYPT_COST);

/** Mints a token row and returns the raw value, which exists nowhere else afterwards. */
async function mintToken(input: { userId: number; kind: UserTokenKind }): Promise<string> {
  const token = generateToken();
  await getRawDb().insert(userTokens).values({
    userId: input.userId,
    kind: input.kind,
    tokenHash: hashToken(token),
    expiresAt: expiryFor({ kind: input.kind, now: new Date() }),
  });
  return token;
}

/**
 * Spends a token, atomically.
 *
 * ONE STATEMENT. The "unused and unexpired" test is in the WHERE clause and the
 * row is stamped in the same UPDATE, so two concurrent clicks on the same link
 * cannot both succeed: exactly one of them matches a row.
 */
async function consumeToken(input: { rawToken: string; kind: UserTokenKind }): Promise<ConsumeResult> {
  const [row] = await getRawDb()
    .update(userTokens)
    .set({ usedAt: sql`now()` })
    .where(
      and(
        eq(userTokens.tokenHash, hashToken(input.rawToken)),
        eq(userTokens.kind, input.kind),
        isNull(userTokens.usedAt),
        sql`${userTokens.expiresAt} > now()`,
      ),
    )
    .returning({ userId: userTokens.userId });

  // Used, expired or never existed. The three are one answer on purpose: a
  // caller that could tell them apart would be telling an attacker too.
  if (!row) return { status: 'invalid' };
  return { status: 'ok', userId: row.userId };
}

/** Writes the new hash and moves the session epoch. Returns the instant the caller's fresh session must carry. */
async function writeNewPassword(input: { userId: number; password: string }): Promise<Date> {
  const passwordChangedAt = new Date();
  await getRawDb()
    .update(users)
    .set({ passwordHash: await bcrypt.hash(input.password, BCRYPT_COST), passwordChangedAt })
    .where(eq(users.id, input.userId));
  return passwordChangedAt;
}

/** Mints a confirmation token and mails its link. Never told the caller whether it ran. */
async function mailVerification(input: { user: SelectUser; mail: MailContext }): Promise<void> {
  const token = await mintToken({ userId: input.user.id, kind: 'verify' });
  const url = buildTokenUrl({ origin: input.mail.origin, path: VERIFY_PATH, token });
  const message = verifyEmailTemplate(input.mail.t, { url });
  await sendMail({ to: input.user.email, subject: message.subject, text: message.text });
  log.info('Confirmation mail sent', { userId: input.user.id });
}
