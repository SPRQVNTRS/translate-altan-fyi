/**
 * An invite is spent exactly once, and Postgres is what makes that true
 * (ADR-0009, PROTOCOL.md §5.8.1, M184 spec 02).
 *
 * WHY THIS CANNOT BE A UNIT CASE
 *   The unit suite asserts the RULE against an in-memory fake, and a fake obeys
 *   it by construction because nothing in it runs concurrently. The three
 *   properties below are properties of the TRANSACTION and of the conditional
 *   UPDATE inside it, and each of them fails silently against a store that
 *   looks correct when read:
 *
 *     1. Two CONCURRENT redemptions of one token produce exactly ONE account.
 *        A read-then-write implementation passes every sequential test and
 *        fails this one: both callers read `redeemed_at IS NULL`, both insert.
 *     2. A sequential second redemption is refused, and refused IDENTICALLY to
 *        an unknown token, so a spent invite does not become an oracle
 *        confirming it was once real.
 *     3. A handle collision does NOT spend the invite. PROTOCOL.md §5.8.1
 *        requires it, and only a rollback delivers it: the claim has already
 *        been written when the insert fails.
 *
 *   They are one case because they are one property of one mechanism, and
 *   because splitting them would need three invites minted by three fixtures to
 *   assert something the third already covers.
 *
 * THE PRECONDITION IS A REACHABLE DATABASE
 *   `DB_HOST` and the other `DB_*` variables, and nothing else: no API key and
 *   no server on :3456. The pre-push gate starts no database, so this case
 *   skips there. See `tests/unit/integration-tests-self-skip.test.ts`.
 *
 * ISOLATION
 *   Run-scoped random handles, and every account and invite deleted by id in
 *   `after()`. The invites are deleted separately because
 *   `invites.redeemed_by_account_id` is `ON DELETE SET NULL` on purpose, so
 *   they do not cascade from the account. Nothing pre-existing is read, written
 *   or deleted, and no empty table is required.
 *
 * WHAT THIS FILE MUST NEVER PRINT
 *   No assertion message may carry a raw invite token, an authHash or a
 *   verifier. An invite is a bearer credential and a failing test's output ends
 *   up in a scrollback.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';

import * as schema from '../../drizzle/schema';
import { closePool } from '../../drizzle/db';
import { accounts, invites } from '../../drizzle/schema';
import type { AuthContext, AuthLogger } from '../../app/lib/e2ee/auth-handlers';
import { handleSignup } from '../../app/lib/e2ee/auth-handlers';
import { createDrizzleAccountStore } from '../../app/lib/e2ee/drizzle-account-store.server';
import { deriveServerSecrets } from '../../app/lib/e2ee/server-secrets';
import { generateFamilyId, generateToken } from '../../app/lib/e2ee/tokens';
import { DEFAULT_ARGON2_PARAMS } from '../../app/lib/e2ee/kdf-descriptor';
import {
  computeInviteTokenHash,
  deriveInviteTokenPepper,
  generateInviteToken,
} from '../../app/lib/invites/token';

const DB_HOST = process.env.DB_HOST;

const pool = new pg.Pool({
  host: DB_HOST,
  port: Number(process.env.DB_PORT ?? 5432),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
});

const db = drizzle(pool, { schema });

const RUN = randomUUID().slice(0, 8);
const createdAccountIds: number[] = [];
const createdInviteIds: number[] = [];

const ROOT_SECRET = `test-root-secret-${RUN}`;
const secrets = deriveServerSecrets(ROOT_SECRET);
const inviteTokenPepper = deriveInviteTokenPepper(ROOT_SECRET);

const silentLogger: AuthLogger = { info: () => {}, warn: () => {} };

function createContext(): AuthContext {
  return {
    store: createDrizzleAccountStore(db),
    pepper: secrets.verifierPepper,
    enumerationSecret: secrets.enumerationSecret,
    signupMode: 'invite',
    admission: {
      hashInviteToken: (token: string) => computeInviteTokenHash({ token, pepper: inviteTokenPepper }),
      isBootstrapToken: () => false,
    },
    now: () => new Date(),
    mintToken: generateToken,
    mintFamilyId: generateFamilyId,
    logger: silentLogger,
  };
}

function handleFor(label: string): string {
  return `zzrun-${label}-${RUN}-${randomBytes(3).toString('hex')}`;
}

function signupBody(handle: string, inviteToken: string) {
  return {
    handle,
    authHash: randomBytes(32).toString('base64'),
    kdfDescriptor: {
      salt: randomBytes(16).toString('base64'),
      params: {
        memorySizeKib: DEFAULT_ARGON2_PARAMS.memorySizeKib,
        iterations: DEFAULT_ARGON2_PARAMS.iterations,
        parallelism: DEFAULT_ARGON2_PARAMS.parallelism,
      },
    },
    inviteToken,
  };
}

interface MintedInvite {
  id: number;
  token: string;
}

async function mintInvite(): Promise<MintedInvite> {
  const token = generateInviteToken();
  const [row] = await db
    .insert(invites)
    .values({ tokenHash: computeInviteTokenHash({ token, pepper: inviteTokenPepper }) })
    .returning({ id: invites.id });
  if (!row) throw new Error('could not mint an invite');
  createdInviteIds.push(row.id);
  return { id: row.id, token };
}

before(async () => {
  if (!DB_HOST) return;
  await db.select({ id: invites.id }).from(invites).limit(1);
});

after(async () => {
  if (DB_HOST && createdAccountIds.length > 0) {
    await db.delete(accounts).where(inArray(accounts.id, createdAccountIds));
  }
  if (DB_HOST && createdInviteIds.length > 0) {
    await db.delete(invites).where(inArray(invites.id, createdInviteIds));
  }
  await pool.end();
  // The app's own module-load pool, which this file never queries but which
  // would otherwise keep the run alive forever. See `e2ee-accounts.test.ts`.
  await closePool();
});

describe('an invite is single-use', () => {
  it(
    'is spent once under concurrency, refused identically the second time, and survives a handle collision',
    { skip: !DB_HOST ? 'DB_HOST not set' : false },
    async () => {
      // ---- 1. CONCURRENCY. Two holders of one token, at once. ----
      const shared = await mintInvite();
      const race = await Promise.all([
        handleSignup(signupBody(handleFor('race-a'), shared.token), createContext()),
        handleSignup(signupBody(handleFor('race-b'), shared.token), createContext()),
      ]);

      for (const outcome of race) {
        if (outcome.status === 'created') createdAccountIds.push(outcome.body.account.id);
      }

      const created = race.filter((outcome) => outcome.status === 'created');
      const refused = race.filter((outcome) => outcome.status === 'forbidden');
      assert.equal(created.length, 1, `one invite admitted ${created.length} concurrent signups`);
      assert.equal(refused.length, 1, `the losing signup was not refused with a 403`);

      const winner = created[0];
      if (winner?.status !== 'created') throw new Error('unreachable');

      // The redemption is recorded on the row, and BOTH columns are set: the
      // timestamp is the authoritative spent marker, the reference is the audit
      // trail (see the schema's column docs).
      const [redeemed] = await db.select().from(invites).where(eq(invites.id, shared.id));
      assert.ok(redeemed, 'the invite row disappeared');
      assert.notEqual(redeemed.redeemedAt, null, 'a redeemed invite has no redeemedAt');
      assert.equal(
        redeemed.redeemedByAccountId,
        winner.body.account.id,
        'the invite was not stamped with the account it created',
      );

      // ---- 2. A SEQUENTIAL SECOND REDEMPTION, and the oracle property. ----
      const replay = await handleSignup(signupBody(handleFor('replay'), shared.token), createContext());
      const unknown = await handleSignup(signupBody(handleFor('unknown'), generateInviteToken()), createContext());
      assert.equal(replay.status, 'forbidden', 'a spent invite was accepted a second time');
      assert.equal(unknown.status, 'forbidden');
      if (replay.status !== 'forbidden' || unknown.status !== 'forbidden') throw new Error('unreachable');
      assert.equal(
        replay.reason,
        unknown.reason,
        'a spent invite is distinguishable from one that was never issued',
      );

      // ---- 3. A HANDLE COLLISION MUST NOT SPEND THE INVITE. ----
      // PROTOCOL.md §5.8.1: a mistyped handle must not cost somebody their
      // invitation. The claim is already written when the insert fails, so only
      // the rollback delivers this.
      const fresh = await mintInvite();
      const collision = await handleSignup(signupBody(winner.body.account.handle, fresh.token), createContext());
      assert.equal(collision.status, 'conflict', 'a taken handle did not produce a conflict');

      const [afterCollision] = await db.select().from(invites).where(eq(invites.id, fresh.id));
      assert.equal(afterCollision?.redeemedAt, null, 'a handle collision spent the invite');

      const retry = await handleSignup(signupBody(handleFor('retry'), fresh.token), createContext());
      assert.equal(retry.status, 'created', 'the invite did not survive the handle collision');
      if (retry.status !== 'created') throw new Error('unreachable');
      createdAccountIds.push(retry.body.account.id);
    },
  );
});
