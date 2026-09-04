/**
 * A mailed link is spent exactly once, even when it is clicked twice at the
 * same moment.
 *
 * WHY THIS IS AN INTEGRATION CASE AND NOT A UNIT ONE. The single-use property
 * is not in TypeScript at all: it is the WHERE clause of one UPDATE
 * (`app/services/auth.server.ts`'s `consumeToken`), and only Postgres can be
 * asked whether two concurrent statements can both match the row. A fake store
 * would answer whatever this file made it answer.
 *
 * THE DEFECT THIS CATCHES. A read-then-write pair passes every unit test and
 * every typecheck, and lets two clicks on one reset link both be accepted, so
 * the second password silently wins over the first. It also lets an expired
 * link work if the expiry is checked in application code a moment before the
 * write.
 *
 * ISOLATION. One user, created here, deleted in `after()` by id. The token rows
 * cascade with it.
 */
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { eq } from 'drizzle-orm';

import { closePool, db, poolInitialized } from '../../drizzle/db';
import { users, userTokens } from '../../drizzle/schema';
import { expiryFor, generateToken, hashToken } from '../../app/lib/auth/tokens';
import { verifyEmailToken } from '../../app/services/auth.server';

const DB_HOST = process.env.DB_HOST;

const createdUserIds: number[] = [];

/** One unconfirmed user, so a confirmation token has something to point at. */
async function seedUser(): Promise<number> {
  const [row] = await db
    .insert(users)
    .values({
      email: `zztoken-${Date.now()}-${createdUserIds.length}@example.invalid`,
      passwordHash: '$2b$10$abcdefghijklmnopqrstuvwxyz012345678901234567890123456789',
    })
    .returning({ id: users.id });
  assert.ok(row, 'could not seed the fixture user');
  createdUserIds.push(row.id);
  return row.id;
}

/** Mints a confirmation token row and returns the raw value, exactly as `registerUser` does. */
async function mintVerifyToken(input: { userId: number; expiresAt?: Date }): Promise<string> {
  const token = generateToken();
  await db.insert(userTokens).values({
    userId: input.userId,
    kind: 'verify',
    tokenHash: hashToken(token),
    expiresAt: input.expiresAt ?? expiryFor({ kind: 'verify', now: new Date() }),
  });
  return token;
}

after(async () => {
  for (const id of createdUserIds) {
    await db.delete(users).where(eq(users.id, id));
  }
  await poolInitialized;
  await closePool();
});

describe('a mailed link is single use', () => {
  it(
    'accepts the first click and refuses the second',
    { skip: !DB_HOST ? 'DB_HOST not set' : false },
    async () => {
      const userId = await seedUser();
      const token = await mintVerifyToken({ userId });

      const first = await verifyEmailToken(token);
      const second = await verifyEmailToken(token);

      assert.deepEqual(first, { status: 'ok', userId });
      assert.deepEqual(second, { status: 'invalid' }, 'a spent link still worked');
    },
  );

  it(
    'lets exactly one of two simultaneous clicks through',
    { skip: !DB_HOST ? 'DB_HOST not set' : false },
    async () => {
      const userId = await seedUser();
      const token = await mintVerifyToken({ userId });

      // BOTH START BEFORE EITHER FINISHES. This is the interleaving a
      // read-then-write pair cannot survive, and the reason the consumption is
      // one statement.
      const outcomes = await Promise.all([verifyEmailToken(token), verifyEmailToken(token)]);

      const accepted = outcomes.filter((outcome) => outcome.status === 'ok');
      assert.equal(accepted.length, 1, `${accepted.length} of two simultaneous clicks were accepted`);
    },
  );

  it(
    'refuses an expired link, and says nothing else about it',
    { skip: !DB_HOST ? 'DB_HOST not set' : false },
    async () => {
      const userId = await seedUser();
      const token = await mintVerifyToken({ userId, expiresAt: new Date(Date.now() - 1000) });

      const outcome = await verifyEmailToken(token);

      // The same answer an unknown token gets. Used, expired and never issued
      // are one refusal on purpose.
      assert.deepEqual(outcome, { status: 'invalid' });
    },
  );

  it(
    'refuses a token that was never issued',
    { skip: !DB_HOST ? 'DB_HOST not set' : false },
    async () => {
      assert.deepEqual(await verifyEmailToken(generateToken()), { status: 'invalid' });
    },
  );

  it(
    'confirms the address on the click it accepts',
    { skip: !DB_HOST ? 'DB_HOST not set' : false },
    async () => {
      const userId = await seedUser();
      const before = await db.query.users.findFirst({ where: eq(users.id, userId) });
      assert.equal(before?.emailVerifiedAt, null, 'the fixture user was already confirmed');

      await verifyEmailToken(await mintVerifyToken({ userId }));

      const confirmed = await db.query.users.findFirst({ where: eq(users.id, userId) });
      assert.notEqual(confirmed?.emailVerifiedAt, null, 'the accepted click confirmed nothing');
    },
  );
});
