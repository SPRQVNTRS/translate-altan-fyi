/**
 * The bootstrap token admits exactly ONE first account, even when two callers
 * present it at the same instant (ADR-0009, M184 spec 02).
 *
 * WHY THE TOKEN EXISTS AT ALL
 *   The server never learns a passphrase, so it cannot create an account by
 *   itself: only a real browser doing the real Argon2id/HKDF derivation can.
 *   That makes an env-seeded admin impossible here, and it collides with
 *   "nobody creates an account without an invite", because the FIRST account has
 *   nobody to have minted one. `ACCOUNT_BOOTSTRAP_TOKEN` is what resolves the
 *   collision, and it is self-invalidating: it is accepted only while `accounts`
 *   is empty, so it dies the moment it works. ADR-0009 rejected the
 *   alternative, a waiver while the table is empty, because that is a public
 *   open door on a public URL.
 *
 * THE PROPERTY UNDER TEST, AND WHY A SEQUENTIAL TEST WOULD NOT SEE IT
 *   "Accepted only while `accounts` is empty" is a read-then-write unless
 *   something serialises it, and the obvious serialisation does not work. A
 *   `SELECT count(*) FROM accounts FOR UPDATE` locks the rows it RETURNED, and
 *   on an empty table it returned none, so two concurrent bootstrap signups both
 *   see zero and both insert. Postgres has no predicate lock outside
 *   SERIALIZABLE. The store therefore takes a transaction-scoped ADVISORY lock
 *   before counting (`BOOTSTRAP_ADVISORY_LOCK_LABEL` in
 *   `drizzle-account-store.server.ts`): the second signup blocks until the first
 *   commits, then counts in a new snapshot, sees one account and is refused.
 *
 *   A sequential test passes against BOTH implementations, the correct one and
 *   the racy one, so this case fires the two signups with `Promise.all` and
 *   asserts exactly one account exists afterwards.
 *
 * WHY IT BUILDS ITS OWN SCHEMA
 *   The property is about an EMPTY `accounts` table, and the development
 *   database is shared: other work has rows in it, and truncating them would be
 *   destroying somebody else's state to make a test pass. So the case creates a
 *   run-scoped Postgres SCHEMA, clones the three tables it needs into it with
 *   `CREATE TABLE ... (LIKE public.<t> INCLUDING ALL)`, points the pool's
 *   `search_path` at it, and drops it in `after()`. Inside that schema
 *   "`accounts` is empty" is a fact this file owns rather than a precondition it
 *   hopes for.
 *
 *   Two consequences worth stating. The clones carry the real column types,
 *   defaults, checks and unique indexes, which is what the redemption path
 *   depends on, but NOT the foreign keys, which `LIKE` never copies; nothing
 *   under test here reads one. And each cloned `id` gets a sequence created
 *   inside the temporary schema, so this file does not even advance a shared
 *   sequence.
 *
 *   The advisory lock is cluster-scoped rather than schema-scoped, which is
 *   correct and costs nothing: it only has to serialise the two callers in this
 *   case against each other.
 *
 * THE PRECONDITION IS A REACHABLE DATABASE
 *   `DB_HOST` and the other `DB_*` variables, and nothing else: no API key and
 *   no server on :3456. The pre-push gate starts no database, so this case
 *   skips there. See `tests/unit/integration-tests-self-skip.test.ts`.
 *
 * WHAT THIS FILE MUST NEVER PRINT
 *   No assertion message may carry the bootstrap token, an authHash or a
 *   verifier.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { count } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';

import * as schema from '../../drizzle/schema';
import { closePool } from '../../drizzle/db';
import { accounts } from '../../drizzle/schema';
import type { AuthContext, AuthLogger } from '../../app/lib/e2ee/auth-handlers';
import { handleSignup } from '../../app/lib/e2ee/auth-handlers';
import { createDrizzleAccountStore } from '../../app/lib/e2ee/drizzle-account-store.server';
import { deriveServerSecrets } from '../../app/lib/e2ee/server-secrets';
import { generateFamilyId, generateToken } from '../../app/lib/e2ee/tokens';
import { DEFAULT_ARGON2_PARAMS } from '../../app/lib/e2ee/kdf-descriptor';
import {
  computeInviteTokenHash,
  deriveInviteTokenPepper,
  inviteTokenHashMatches,
} from '../../app/lib/invites/token';

const DB_HOST = process.env.DB_HOST;

/** Run-scoped, so two runs of this file can never share a table. */
const RUN = randomUUID().replaceAll('-', '').slice(0, 12);
const TEST_SCHEMA = `zz_bootstrap_${RUN}`;

/**
 * `search_path` is set on the CONNECTION, not per statement, so every pooled
 * connection resolves the unqualified table names in the Drizzle schema to the
 * clones rather than to `public`. Only `pg_catalog` remains implicitly ahead of
 * it, which is what keeps `pg_advisory_xact_lock` and `hashtext` reachable.
 */
const pool = new pg.Pool({
  host: DB_HOST,
  port: Number(process.env.DB_PORT ?? 5432),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  options: `-c search_path=${TEST_SCHEMA}`,
});

const db = drizzle(pool, { schema });

/** A test-only root secret. Nothing here reads the environment's `SERVER_SECRET`. */
const ROOT_SECRET = `test-root-secret-${RUN}`;
const secrets = deriveServerSecrets(ROOT_SECRET);
const inviteTokenPepper = deriveInviteTokenPepper(ROOT_SECRET);

/** The operator's one-shot secret, generated per run so it is never a literal in the repository. */
const BOOTSTRAP_TOKEN = `bootstrap-${randomBytes(24).toString('hex')}`;

const silentLogger: AuthLogger = { info: () => {}, warn: () => {} };

/**
 * The context an instance has on its very first boot: invite mode, and a
 * configured bootstrap token.
 *
 * `isBootstrapToken` is the same construction the composition root uses, both
 * sides hashed then compared constant-time, rather than a `===`, so this case
 * exercises the shape the app actually runs.
 */
function createContext(): AuthContext {
  return {
    store: createDrizzleAccountStore(db),
    pepper: secrets.verifierPepper,
    enumerationSecret: secrets.enumerationSecret,
    signupMode: 'invite',
    admission: {
      hashInviteToken: (token: string) => computeInviteTokenHash({ token, pepper: inviteTokenPepper }),
      isBootstrapToken: (token: string) =>
        inviteTokenHashMatches({
          candidate: computeInviteTokenHash({ token, pepper: inviteTokenPepper }),
          stored: computeInviteTokenHash({ token: BOOTSTRAP_TOKEN, pepper: inviteTokenPepper }),
        }),
    },
    now: () => new Date(),
    mintToken: generateToken,
    mintFamilyId: generateFamilyId,
    logger: silentLogger,
  };
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

/** The three tables the signup path writes, cloned into the run's own schema. */
const CLONED_TABLES = ['accounts', 'account_tokens', 'invites'] as const;

async function createTestSchema(): Promise<void> {
  await pool.query(`CREATE SCHEMA ${TEST_SCHEMA}`);
  for (const [index, table] of CLONED_TABLES.entries()) {
    await pool.query(`CREATE TABLE ${TEST_SCHEMA}.${table} (LIKE public.${table} INCLUDING ALL)`);
    // `LIKE` copies the DEFAULT expression verbatim, which for a `serial`
    // column still names the sequence in `public`. Re-pointing it at a local
    // one is what keeps this file from advancing a shared sequence.
    const sequence = `${TEST_SCHEMA}.seq_${index}`;
    await pool.query(`CREATE SEQUENCE ${sequence} OWNED BY ${TEST_SCHEMA}.${table}.id`);
    await pool.query(`ALTER TABLE ${TEST_SCHEMA}.${table} ALTER COLUMN id SET DEFAULT nextval('${sequence}')`);
  }
}

async function countAccounts(): Promise<number> {
  const [row] = await db.select({ value: count() }).from(accounts);
  return Number(row?.value ?? 0);
}

before(async () => {
  if (!DB_HOST) return;
  await createTestSchema();
});

after(async () => {
  if (DB_HOST) {
    // The whole schema, so there is no row-by-row cleanup to get wrong. Nothing
    // outside it was ever written.
    await pool.query(`DROP SCHEMA IF EXISTS ${TEST_SCHEMA} CASCADE`);
  }
  await pool.end();
  // The app's own module-load pool, which this file never queries but which
  // would otherwise keep the run alive forever. See `e2ee-accounts.test.ts`.
  await closePool();
});

describe('the bootstrap token admits one first account', () => {
  it(
    'admits exactly one of two concurrent signups on an empty table, then never works again',
    { skip: !DB_HOST ? 'DB_HOST not set' : false },
    async () => {
      assert.equal(await countAccounts(), 0, 'this case needs an empty accounts table and did not get one');

      // THE RACE. Both callers hold the same one-shot token and arrive at once.
      // A read-then-write implementation gives two accounts here.
      const race = await Promise.all([
        handleSignup(signupBody('first-a', BOOTSTRAP_TOKEN), createContext()),
        handleSignup(signupBody('first-b', BOOTSTRAP_TOKEN), createContext()),
      ]);

      const created = race.filter((outcome) => outcome.status === 'created');
      const refused = race.filter((outcome) => outcome.status === 'forbidden');
      assert.equal(created.length, 1, `the bootstrap token admitted ${created.length} concurrent signups`);
      assert.equal(refused.length, 1, 'the losing bootstrap signup was not refused with a 403');
      assert.equal(await countAccounts(), 1, 'the accounts table does not hold exactly one first account');

      // SELF-INVALIDATING. One account exists, so the precondition is false for
      // the rest of the instance's life and the branch is dead code. This is the
      // operational promise ADR-0009 makes about not having to rotate the token.
      const later = await handleSignup(signupBody('second', BOOTSTRAP_TOKEN), createContext());
      assert.equal(later.status, 'forbidden', 'the bootstrap token still worked after the first account');
      assert.equal(await countAccounts(), 1, 'a refused bootstrap signup wrote an account');

      // And the refusal is the SAME one an unknown invite gets, so a caller
      // cannot use it to learn that a bootstrap token was once configured here.
      const unknownInvite = await handleSignup(signupBody('third', 'si_never-issued'), createContext());
      assert.equal(unknownInvite.status, 'forbidden');
      if (later.status !== 'forbidden' || unknownInvite.status !== 'forbidden') throw new Error('unreachable');
      assert.equal(
        later.reason,
        unknownInvite.reason,
        'a spent bootstrap token is distinguishable from an unknown invite',
      );
    },
  );
});
