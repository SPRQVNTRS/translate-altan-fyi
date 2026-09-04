/**
 * The gate itself: `POST /v1/auth/signup` creates nothing without an invite
 * (ADR-0009, PROTOCOL.md §5.8.1, M184 spec 02).
 *
 * WHY THIS IS A DB-BACKED CASE AND NOT A UNIT ONE
 *   `tests/unit/e2ee/auth-handlers.test.ts` already asserts the POLICY against
 *   an in-memory fake, and it should. What a fake cannot prove is the half that
 *   only Postgres owns: that the refusal is decided by a real lookup against a
 *   real `invites` table whose stored value is a keyed hash and not the token,
 *   and that a refused signup leaves the accounts table exactly as it was. A
 *   fake store answers both by construction, which is the same reason
 *   `e2ee-accounts.test.ts` exists beside the unit suite.
 *
 * WHAT IT ASSERTS, AND WHY IT IS ONE CASE
 *   Six refusals and two successes are one property, not eight: an unadmitted
 *   signup must be refused, and every way of being unadmitted must be refused
 *   IDENTICALLY. Splitting them into separate cases would let the important
 *   assertion, that the reason strings are equal, disappear between them.
 *
 * THE PRECONDITION IS A REACHABLE DATABASE
 *   `DB_HOST` and the other `DB_*` variables, and nothing else: no API key and
 *   no server on :3456. The pre-push gate starts no database, so this case
 *   skips there. See `tests/unit/integration-tests-self-skip.test.ts`, which
 *   counts cases against skip guards one for one.
 *
 * ISOLATION
 *   Every handle carries a run-scoped random suffix. The one account and the
 *   invites this file creates are deleted in `after()`, by id. The invites are
 *   deleted separately from the account because
 *   `invites.redeemed_by_account_id` is `ON DELETE SET NULL` on purpose, so
 *   they do not cascade. Nothing pre-existing is read, written or deleted, and
 *   in particular this file does NOT require an empty `accounts` table: it
 *   creates its own row so the table is non-empty, which is the state the
 *   bootstrap branch must be dead in.
 *
 * WHAT THIS FILE MUST NEVER PRINT
 *   No assertion message may carry a raw invite token, an authHash or a
 *   verifier. A failing test's output ends up in a terminal, a scrollback and
 *   sometimes a paste, and an invite token is a bearer credential.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { count, inArray } from 'drizzle-orm';
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
import type { JsonValue } from '../../app/lib/e2ee/json';
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

/** Every handle this run creates carries this suffix, so cleanup can be exact. */
const RUN = randomUUID().slice(0, 8);

const createdAccountIds: number[] = [];
const createdInviteIds: number[] = [];

/** A test-only root secret. Nothing here reads the environment's `SERVER_SECRET`. */
const ROOT_SECRET = `test-root-secret-${RUN}`;
const secrets = deriveServerSecrets(ROOT_SECRET);
const inviteTokenPepper = deriveInviteTokenPepper(ROOT_SECRET);

/** Silent: these handlers log account ids, and a real logger in a suite is noise. */
const silentLogger: AuthLogger = { info: () => {}, warn: () => {} };

/**
 * The context under test, with NO bootstrap token configured, the state of a
 * deployed instance that has already used its one-shot token, and of one that
 * never set the variable at all.
 */
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

/**
 * A well-formed signup body. An `inviteToken` of `undefined` leaves the KEY
 * OUT, rather than present and undefined, because "the client sent no field" is
 * one of the refusals under test and the two are not the same request.
 */
function signupBody(label: string, inviteToken?: JsonValue) {
  const body = {
    handle: handleFor(label),
    authHash: randomBytes(32).toString('base64'),
    kdfDescriptor: {
      salt: randomBytes(16).toString('base64'),
      params: {
        memorySizeKib: DEFAULT_ARGON2_PARAMS.memorySizeKib,
        iterations: DEFAULT_ARGON2_PARAMS.iterations,
        parallelism: DEFAULT_ARGON2_PARAMS.parallelism,
      },
    },
  };
  if (inviteToken === undefined) return body;
  return { ...body, inviteToken };
}

/** Mints one real `invites` row and returns the plaintext, exactly as the CLI would. */
async function mintInvite(options: { expiresAt?: Date } = {}): Promise<string> {
  const token = generateInviteToken();
  const [row] = await db
    .insert(invites)
    .values({
      tokenHash: computeInviteTokenHash({ token, pepper: inviteTokenPepper }),
      expiresAt: options.expiresAt ?? null,
    })
    .returning({ id: invites.id });
  if (!row) throw new Error('could not mint an invite');
  createdInviteIds.push(row.id);
  return token;
}

async function countAccounts(): Promise<number> {
  const [row] = await db.select({ value: count() }).from(accounts);
  return Number(row?.value ?? 0);
}

before(async () => {
  if (!DB_HOST) return;
  // Fails loudly here rather than as an obscure error inside the case.
  await db.select({ id: invites.id }).from(invites).limit(1);
});

after(async () => {
  if (DB_HOST && createdAccountIds.length > 0) {
    await db.delete(accounts).where(inArray(accounts.id, createdAccountIds));
  }
  if (DB_HOST && createdInviteIds.length > 0) {
    // Separately, and by id: these rows do not cascade from the account.
    await db.delete(invites).where(inArray(invites.id, createdInviteIds));
  }
  await pool.end();
  // AND THE APP'S OWN POOL, which this file never asked for.
  // `drizzle-account-store.server.ts` imports `#drizzle/tenant-db`, which opens
  // a pool AT MODULE LOAD. It is never queried, because the store under test is
  // built with the local `db` above, but an open pool is a live handle and
  // `node --test` sets no timeout: leaving it behind does not fail the run, it
  // makes the run never end.
  await closePool();
});

describe('signup requires an invite', () => {
  it(
    'refuses every unadmitted signup identically, and creates nothing',
    { skip: !DB_HOST ? 'DB_HOST not set' : false },
    async () => {
      // A REAL INVITE FIRST, so the table this file asserts against is
      // non-empty. That matters: it is the state in which the bootstrap branch
      // is dead, so every refusal below is a refusal of the invite path alone.
      const admitted = await handleSignup(signupBody('admitted', await mintInvite()), createContext());
      assert.equal(admitted.status, 'created', 'a freshly minted invite was refused');
      if (admitted.status !== 'created') throw new Error('unreachable');
      createdAccountIds.push(admitted.body.account.id);

      // A SECOND success, whose only job is to leave a SPENT invite behind for
      // the refusal list below.
      const spent = await mintInvite();
      const spentSignup = await handleSignup(signupBody('spend', spent), createContext());
      assert.equal(spentSignup.status, 'created');
      if (spentSignup.status !== 'created') throw new Error('unreachable');
      createdAccountIds.push(spentSignup.body.account.id);

      const expired = await mintInvite({ expiresAt: new Date(Date.now() - 60_000) });

      // Counted AFTER the last admitted signup, so the assertion at the end is
      // about the refusals and nothing else.
      const accountsBefore = await countAccounts();
      assert.ok(accountsBefore > 0, 'the accounts table is empty, so this case is not asserting what it claims');

      // SIX WAYS TO BE UNADMITTED. The field absent, the field empty (which is
      // also what an installation with no `ACCOUNT_BOOTSTRAP_TOKEN` must refuse
      // rather than treat as a match), a token that was never issued, one that
      // belongs to another service, one already spent, and one past its expiry.
      const refusals = await Promise.all([
        handleSignup(signupBody('absent', undefined), createContext()),
        handleSignup(signupBody('empty', ''), createContext()),
        handleSignup(signupBody('unknown', generateInviteToken()), createContext()),
        handleSignup(signupBody('gateway', 'gi_belongs-to-the-gateway'), createContext()),
        handleSignup(signupBody('spent', spent), createContext()),
        handleSignup(signupBody('expired', expired), createContext()),
      ]);

      for (const refusal of refusals) {
        assert.equal(refusal.status, 'forbidden', 'an unadmitted signup was not refused with a 403');
      }

      // THE PROPERTY THAT MATTERS, and the reason these are one case. Never
      // issued, wrong service, already redeemed, expired and absent must be ONE
      // answer, byte for byte. A caller who can tell them apart can probe which
      // tokens exist and confirm that a leaked one was once real
      // (PROTOCOL.md §5.8.1).
      const reasons = new Set(refusals.map((refusal) => (refusal.status === 'forbidden' ? refusal.reason : '?')));
      assert.equal(reasons.size, 1, `six causes produced ${reasons.size} distinguishable answers`);

      // AND NOTHING WAS WRITTEN. The refusals opened a transaction each; every
      // one of them rolled back.
      assert.equal(await countAccounts(), accountsBefore, 'a refused signup changed the accounts table');
    },
  );
});
