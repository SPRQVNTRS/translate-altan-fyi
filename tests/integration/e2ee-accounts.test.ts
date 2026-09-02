/**
 * The account system, proven against a real Postgres and the REAL Drizzle
 * store.
 *
 * WHY A DB-BACKED TEST AT ALL
 *   `tests/unit/e2ee/` already exercises the handler cores against an
 *   in-memory fake, and that suite is the right place for policy. What it
 *   CANNOT prove is the half of this system that Postgres owns: that the
 *   unique index on `accounts.handle` is what makes concurrent signups safe,
 *   that `recoverAndRotatePassphrase` moves the verifier and the key records
 *   inside ONE transaction, that a compare-and-swap on `updatedAt` actually
 *   matches a row, and that revoking a token family is a statement rather than
 *   an intention. A fake store passes every one of those by construction.
 *
 *   The millisecond-precision case below is the sharpest example. It is a
 *   REGRESSION test for a real bug (openplate-sync M160 spec 06): while
 *   `sync_key_records.updated_at` was a bare `timestamp` (= `timestamp(6)`),
 *   the CAS token a client read back over the wire was an ISO-8601 string
 *   carrying milliseconds, while the stored value carried a MICROSECOND tail
 *   the wire could not express. Exact equality then matched zero rows and
 *   every rotation 409'd forever. No fake store can reproduce that, because
 *   nothing but Postgres has the extra digits.
 *
 * THE PRECONDITION IS A REACHABLE DATABASE
 *   `DB_HOST` and the other `DB_*` variables, and nothing else: no API key,
 *   and no server on :3456. Every case therefore gates on `DB_HOST` alone.
 *   The pre-push gate starts no database, so every case here skips there. See
 *   `tests/unit/integration-tests-self-skip.test.ts`, which counts test cases
 *   against skip guards and fails the unit tier if they do not match
 *   one-for-one.
 *
 * ISOLATION
 *   Every handle this file creates carries a run-scoped random suffix, and
 *   every account it creates is deleted again in `after()`. Deleting the
 *   account is enough: `account_tokens` and `sync_key_records` both cascade
 *   from it, which is the same `ON DELETE CASCADE` the self-serve erasure path
 *   relies on. Nothing pre-existing is read, written or deleted.
 *
 * WHAT THIS FILE MUST NEVER PRINT
 *   No assertion message may carry a raw token, an authHash, a passphrase or a
 *   wrapped DEK. A failing test's output ends up in a terminal, a scrollback
 *   and sometimes a paste.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';

import * as schema from '../../drizzle/schema';
import { closePool } from '../../drizzle/db';
import { accountTokens, accounts } from '../../drizzle/schema';
import type { AuthContext, AuthLogger } from '../../app/lib/e2ee/auth-handlers';
import {
  handleLogin,
  handleRecoverRotate,
  handleRefresh,
  handleSignup,
} from '../../app/lib/e2ee/auth-handlers';
import { handlePutKeyRecord } from '../../app/lib/e2ee/key-records-handler';
import { createDrizzleAccountStore } from '../../app/lib/e2ee/drizzle-account-store.server';
import { createDrizzleStorageAdapter } from '../../app/services/e2ee-storage-adapter.server';
import { deriveServerSecrets } from '../../app/lib/e2ee/server-secrets';
import { generateFamilyId, generateToken, hashToken } from '../../app/lib/e2ee/tokens';
import { computeVerifier } from '../../app/lib/e2ee/verifier';
import { DEFAULT_ARGON2_PARAMS } from '../../app/lib/e2ee/kdf-descriptor';
import type { JsonObject } from '../../app/lib/e2ee/json';

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

/** The account ids this run created. `after()` deletes exactly these; the rest cascades. */
const createdAccountIds: number[] = [];

/** A test-only root secret. Nothing here reads the environment's `SERVER_SECRET`. */
const secrets = deriveServerSecrets(`test-root-secret-${RUN}`);

/** Silent, because a real logger in a test suite is noise and these handlers log account ids. */
const silentLogger: AuthLogger = { info: () => {}, warn: () => {} };

function createContext(): AuthContext {
  return {
    store: createDrizzleAccountStore(db),
    pepper: secrets.verifierPepper,
    enumerationSecret: secrets.enumerationSecret,
    signupMode: 'open',
    now: () => new Date(),
    mintToken: generateToken,
    mintFamilyId: generateFamilyId,
    logger: silentLogger,
  };
}

/** A base64 32-byte value, the shape every `authHash` field takes on the wire. */
function authHash(): string {
  return randomBytes(32).toString('base64');
}

/**
 * A base64 16-byte salt plus the published Argon2id defaults (PROTOCOL.md §3.1).
 *
 * TYPED AS `JsonObject`, NOT `KdfDescriptor`, because that is what it is on the
 * wire: a descriptor arrives as undecoded JSON and `parseKdfDescriptor` is what
 * turns it into a domain value. Handing the handlers a pre-built domain type
 * would test a path no client can take.
 */
function kdfDescriptor(): JsonObject {
  return {
    salt: randomBytes(16).toString('base64'),
    params: {
      memorySizeKib: DEFAULT_ARGON2_PARAMS.memorySizeKib,
      iterations: DEFAULT_ARGON2_PARAMS.iterations,
      parallelism: DEFAULT_ARGON2_PARAMS.parallelism,
    },
  };
}

/** An opaque wrapped-DEK blob. Its bytes are never inspected by anything under test. */
function wrappedDek(): string {
  return randomBytes(60).toString('base64');
}

function handleFor(label: string): string {
  return `zzrun-${label}-${RUN}-${randomBytes(3).toString('hex')}`;
}

interface SignedUpAccount {
  accountId: number;
  handle: string;
  authHash: string;
  recoveryAuthHash: string;
  accessToken: string;
  refreshToken: string;
}

/** Creates one account through the real signup handler and records it for cleanup. */
async function signUp(label: string): Promise<SignedUpAccount> {
  const body = {
    handle: handleFor(label),
    authHash: authHash(),
    kdfDescriptor: kdfDescriptor(),
    recoveryAuthHash: authHash(),
  };

  const outcome = await handleSignup(body, createContext());
  assert.equal(outcome.status, 'created', 'signup did not create an account');
  if (outcome.status !== 'created') throw new Error('unreachable');

  createdAccountIds.push(outcome.body.account.id);
  return {
    accountId: outcome.body.account.id,
    handle: body.handle,
    authHash: body.authHash,
    recoveryAuthHash: body.recoveryAuthHash,
    accessToken: outcome.body.tokens.accessToken,
    refreshToken: outcome.body.tokens.refreshToken,
  };
}

before(async () => {
  if (!DB_HOST) return;
  // Fails loudly here rather than as an obscure error inside the first case.
  await db.select({ id: accounts.id }).from(accounts).limit(1);
});

after(async () => {
  if (DB_HOST && createdAccountIds.length > 0) {
    // ONE delete. `account_tokens` and `sync_key_records` both carry
    // `ON DELETE CASCADE` on `account_id`, which is the same mechanism the
    // self-serve erasure path relies on, so cleaning up this way exercises it.
    await db.delete(accounts).where(inArray(accounts.id, createdAccountIds));
  }
  await pool.end();

  // AND THE APP'S OWN POOL, which this file never asked for.
  // `drizzle-account-store.server.ts` and `e2ee-storage-adapter.server.ts` both
  // import `#drizzle/tenant-db`, which opens a connection pool AT MODULE LOAD.
  // Every store under test is constructed with the local `db` above, so that
  // pool is never queried — but it is open, and an open pool is a live handle.
  // `node --test` sets no timeout, so leaving it behind does not fail the run:
  // it makes the run never end, and `pnpm test:integration` hangs for whoever
  // types it next. Closing it is the difference between a green suite and a
  // hung terminal.
  await closePool();
});

describe('e2ee accounts, against a real database', () => {
  it(
    'signup issues a pair and stores a verifier that is not the submitted authHash',
    { skip: !DB_HOST ? 'DB_HOST not set' : false },
    async () => {
      const account = await signUp('signup');

      assert.ok(account.accessToken.length > 0, 'no access token was issued');
      assert.ok(account.refreshToken.length > 0, 'no refresh token was issued');
      assert.notEqual(account.accessToken, account.refreshToken, 'the two tokens are the same string');

      const [row] = await db.select().from(accounts).where(eq(accounts.id, account.accountId));
      assert.ok(row, 'the account row was not written');

      // THE PROPERTY THAT MATTERS. What is stored is `HMAC(pepper, authHash)`,
      // never the client's auth-hash. With the pepper outside the database, a
      // dumped table cannot be replayed against a live instance.
      assert.notEqual(row.verifier, account.authHash, 'the raw authHash was stored as the verifier');
      assert.equal(row.verifier, computeVerifier({ authHash: account.authHash, pepper: secrets.verifierPepper }));
      assert.equal(
        row.recoveryVerifier,
        computeVerifier({ authHash: account.recoveryAuthHash, pepper: secrets.verifierPepper }),
      );

      // Only digests are persisted, so a dumped token table yields nothing replayable.
      const tokenRows = await db.select().from(accountTokens).where(eq(accountTokens.accountId, account.accountId));
      assert.equal(tokenRows.length, 2, 'expected exactly one access and one refresh row');
      assert.deepEqual(tokenRows.map((token) => token.kind).toSorted(), ['access', 'refresh']);
      assert.ok(
        tokenRows.every((token) => token.tokenHash !== account.accessToken && token.tokenHash !== account.refreshToken),
        'a raw token was stored instead of its digest',
      );
      assert.ok(
        tokenRows.every((token) => token.familyId === tokenRows[0]?.familyId && token.familyId !== null),
        'the pair does not share one family id',
      );
    },
  );

  it(
    'login accepts the right authHash, and a wrong one is indistinguishable from an unknown handle',
    { skip: !DB_HOST ? 'DB_HOST not set' : false },
    async () => {
      const account = await signUp('login');

      const good = await handleLogin({ handle: account.handle, authHash: account.authHash }, createContext());
      assert.equal(good.status, 'ok', 'the correct authHash was rejected');

      const wrongPassphrase = await handleLogin({ handle: account.handle, authHash: authHash() }, createContext());
      const unknownHandle = await handleLogin({ handle: handleFor('nobody'), authHash: authHash() }, createContext());

      assert.equal(wrongPassphrase.status, 'unauthorized');
      assert.equal(unknownHandle.status, 'unauthorized');
      if (wrongPassphrase.status !== 'unauthorized' || unknownHandle.status !== 'unauthorized') {
        throw new Error('unreachable');
      }

      // THE WHOLE POINT. A wrong passphrase and a handle that does not exist
      // must be one answer, byte for byte. A caller that can tell them apart
      // has an account-enumeration oracle.
      assert.equal(
        wrongPassphrase.reason,
        unknownHandle.reason,
        'a wrong passphrase and an unknown handle are distinguishable',
      );
    },
  );

  it(
    'refresh rotates: the presented token is revoked and a new pair is issued',
    { skip: !DB_HOST ? 'DB_HOST not set' : false },
    async () => {
      const account = await signUp('rotate');

      const outcome = await handleRefresh({ refreshToken: account.refreshToken }, createContext());
      assert.equal(outcome.status, 'ok', 'a valid refresh token was rejected');
      if (outcome.status !== 'ok') throw new Error('unreachable');

      assert.notEqual(outcome.body.tokens.refreshToken, account.refreshToken, 'the refresh token was not replaced');

      const [presented] = await db
        .select()
        .from(accountTokens)
        .where(eq(accountTokens.tokenHash, hashToken(account.refreshToken)));
      assert.ok(presented, 'the presented refresh row disappeared');
      assert.notEqual(presented.revokedAt, null, 'the presented refresh token was not revoked');

      // The rotation stays in the same family, which is what lets `logout`
      // revoke one device and reuse detection revoke one lineage.
      const [minted] = await db
        .select()
        .from(accountTokens)
        .where(eq(accountTokens.tokenHash, hashToken(outcome.body.tokens.refreshToken)));
      assert.ok(minted, 'the new refresh row was not written');
      assert.equal(minted.familyId, presented.familyId, 'the rotation started a new family');
      assert.equal(minted.revokedAt, null, 'the freshly minted refresh token is already revoked');
    },
  );

  it(
    'refresh REUSE revokes the whole family',
    { skip: !DB_HOST ? 'DB_HOST not set' : false },
    async () => {
      const account = await signUp('reuse');

      const first = await handleRefresh({ refreshToken: account.refreshToken }, createContext());
      assert.equal(first.status, 'ok');
      if (first.status !== 'ok') throw new Error('unreachable');

      const [seed] = await db
        .select()
        .from(accountTokens)
        .where(eq(accountTokens.tokenHash, hashToken(account.refreshToken)));
      assert.ok(seed?.familyId, 'the seed row has no family id');
      const familyId = seed.familyId;

      // The replay. Whoever presents an already-rotated refresh token holds a
      // copy they should not, so the whole lineage goes: the attacker AND the
      // real user. That is the correct response, because the alternative leaves
      // a thief with a working session.
      const replay = await handleRefresh({ refreshToken: account.refreshToken }, createContext());
      assert.equal(replay.status, 'unauthorized', 'a reused refresh token was accepted');

      const family = await db.select().from(accountTokens).where(eq(accountTokens.familyId, familyId));
      assert.ok(family.length >= 3, `expected at least the seed pair plus one rotation, got ${family.length}`);
      assert.deepEqual(
        family.filter((token) => token.revokedAt === null).map((token) => token.kind),
        [],
        'a token in the reused family survived',
      );

      // And the tokens the reuse revoked are genuinely dead, not merely stamped.
      const afterRevocation = await handleRefresh({ refreshToken: first.body.tokens.refreshToken }, createContext());
      assert.equal(afterRevocation.status, 'unauthorized', 'the legitimate rotation still works after a reuse');
    },
  );

  it(
    'recovery rotation moves the verifier and the key records together, and a wrong code changes nothing',
    { skip: !DB_HOST ? 'DB_HOST not set' : false },
    async () => {
      const account = await signUp('recover');
      const store = createDrizzleStorageAdapter(db);

      // The account starts with a `passphrase` record wrapping its DEK.
      const seeded = await handlePutKeyRecord(
        {
          accountId: account.accountId,
          kind: 'passphrase',
          kdfDescriptor: { ...kdfDescriptor() },
          wrappedDek: new Uint8Array(Buffer.from(wrappedDek(), 'base64')),
          expectedUpdatedAt: null,
        },
        store,
      );
      assert.equal(seeded.status, 'ok', 'could not seed the passphrase key record');
      if (seeded.status !== 'ok') throw new Error('unreachable');
      const originalDek = Buffer.from(seeded.record.wrappedDek).toString('base64');

      const [beforeRotation] = await db.select().from(accounts).where(eq(accounts.id, account.accountId));
      assert.ok(beforeRotation);

      // A WRONG CODE CHANGES NOTHING. Not the verifier, not the key record.
      const refused = await handleRecoverRotate(
        {
          handle: account.handle,
          recoveryAuthHash: authHash(),
          newAuthHash: authHash(),
          kdfDescriptor: kdfDescriptor(),
          keyRecords: [{ kind: 'passphrase', kdfDescriptor: kdfDescriptor(), wrappedDek: wrappedDek() }],
        },
        createContext(),
      );
      assert.equal(refused.status, 'unauthorized', 'a wrong recovery code was accepted');

      const [unchanged] = await db.select().from(accounts).where(eq(accounts.id, account.accountId));
      assert.equal(unchanged?.verifier, beforeRotation.verifier, 'a refused rotation moved the verifier');
      const stillThere = await store.listKeyRecords(account.accountId);
      assert.equal(
        Buffer.from(stillThere[0]?.wrappedDek ?? new Uint8Array()).toString('base64'),
        originalDek,
        'a refused rotation re-wrapped the DEK',
      );

      // The real rotation: new passphrase, re-wrapped DEK, new recovery code
      // and its own re-wrapped record. All of it, or none of it.
      const newAuthHash = authHash();
      const newRecoveryAuthHash = authHash();
      const rotated = await handleRecoverRotate(
        {
          handle: account.handle,
          recoveryAuthHash: account.recoveryAuthHash,
          newAuthHash,
          kdfDescriptor: kdfDescriptor(),
          newRecoveryAuthHash,
          keyRecords: [
            { kind: 'passphrase', kdfDescriptor: kdfDescriptor(), wrappedDek: wrappedDek() },
            { kind: 'recovery', kdfDescriptor: null, wrappedDek: wrappedDek() },
          ],
        },
        createContext(),
      );
      assert.equal(rotated.status, 'ok', 'the correct recovery code was rejected');

      const [rotatedRow] = await db.select().from(accounts).where(eq(accounts.id, account.accountId));
      assert.ok(rotatedRow);
      assert.equal(
        rotatedRow.verifier,
        computeVerifier({ authHash: newAuthHash, pepper: secrets.verifierPepper }),
        'the passphrase verifier did not move',
      );
      assert.equal(
        rotatedRow.recoveryVerifier,
        computeVerifier({ authHash: newRecoveryAuthHash, pepper: secrets.verifierPepper }),
        'the recovery verifier did not move',
      );

      // BOTH HALVES, OR NEITHER. A verifier that moved without its re-wrapped
      // record is an account that logs in perfectly and decrypts nothing.
      const records = await store.listKeyRecords(account.accountId);
      assert.deepEqual(records.map((record) => record.kind).toSorted(), ['passphrase', 'recovery']);
      const passphraseRecord = records.find((record) => record.kind === 'passphrase');
      assert.notEqual(
        Buffer.from(passphraseRecord?.wrappedDek ?? new Uint8Array()).toString('base64'),
        originalDek,
        'the passphrase record was not re-wrapped',
      );

      // The new passphrase works and the old one does not.
      assert.equal(
        (await handleLogin({ handle: account.handle, authHash: newAuthHash }, createContext())).status,
        'ok',
      );
      assert.equal(
        (await handleLogin({ handle: account.handle, authHash: account.authHash }, createContext())).status,
        'unauthorized',
      );
    },
  );

  it(
    'a passphrase key record requires a kdfDescriptor and a recovery record must not carry one',
    { skip: !DB_HOST ? 'DB_HOST not set' : false },
    async () => {
      const account = await signUp('kinds');
      const store = createDrizzleStorageAdapter(db);
      const dek = new Uint8Array(Buffer.from(wrappedDek(), 'base64'));

      const passphraseWithout = await handlePutKeyRecord(
        { accountId: account.accountId, kind: 'passphrase', kdfDescriptor: null, wrappedDek: dek, expectedUpdatedAt: null },
        store,
      );
      assert.equal(passphraseWithout.status, 'invalid', 'a passphrase record without a descriptor was accepted');

      // D5: the recovery path is HKDF-only, so there are no Argon2id
      // parameters to record. A descriptor here would be a value nothing reads
      // and a client could mistake for the one that matters.
      const recoveryWith = await handlePutKeyRecord(
        {
          accountId: account.accountId,
          kind: 'recovery',
          kdfDescriptor: { ...kdfDescriptor() },
          wrappedDek: dek,
          expectedUpdatedAt: null,
        },
        store,
      );
      assert.equal(recoveryWith.status, 'invalid', 'a recovery record carrying a descriptor was accepted');

      // Neither refusal wrote anything.
      assert.deepEqual(await store.listKeyRecords(account.accountId), []);

      const recoveryWithout = await handlePutKeyRecord(
        { accountId: account.accountId, kind: 'recovery', kdfDescriptor: null, wrappedDek: dek, expectedUpdatedAt: null },
        store,
      );
      assert.equal(recoveryWithout.status, 'ok', 'a well-formed recovery record was refused');
    },
  );

  it(
    'the compare-and-swap rejects a stale write, and updatedAt survives an ISO-8601 round trip',
    { skip: !DB_HOST ? 'DB_HOST not set' : false },
    async () => {
      const account = await signUp('cas');
      const store = createDrizzleStorageAdapter(db);

      const created = await handlePutKeyRecord(
        {
          accountId: account.accountId,
          kind: 'passphrase',
          kdfDescriptor: { ...kdfDescriptor() },
          wrappedDek: new Uint8Array(Buffer.from(wrappedDek(), 'base64')),
          expectedUpdatedAt: null,
        },
        store,
      );
      assert.equal(created.status, 'ok');
      if (created.status !== 'ok') throw new Error('unreachable');

      // A SECOND first-time create must lose, and its conflict must report the
      // real current token rather than `null`.
      const duplicate = await handlePutKeyRecord(
        {
          accountId: account.accountId,
          kind: 'passphrase',
          kdfDescriptor: { ...kdfDescriptor() },
          wrappedDek: new Uint8Array(Buffer.from(wrappedDek(), 'base64')),
          expectedUpdatedAt: null,
        },
        store,
      );
      assert.equal(duplicate.status, 'conflict', 'a second first-time create was accepted');
      if (duplicate.status !== 'conflict') throw new Error('unreachable');
      assert.notEqual(duplicate.currentUpdatedAt, null, 'the conflict did not report the current token');

      // THE ROUND TRIP THAT MAKES THE CAS WORK AT ALL. The token leaves the
      // server as an ISO-8601 string, which carries MILLISECONDS. If the column
      // held a microsecond tail — which a bare `timestamp` (= `timestamp(6)`)
      // does when `defaultNow()` supplies the value — the string a client reads
      // back would be a truncation of the stored value, exact equality would
      // match zero rows, and every rotation would 409 forever. The column is
      // `timestamp(3)` for exactly this reason. This asserts the property, not
      // the declaration: the value goes out as a string and comes back in as a
      // `Date`, the way a real client's does.
      const wireToken = created.record.updatedAt.toISOString();
      assert.equal(
        new Date(wireToken).getTime(),
        created.record.updatedAt.getTime(),
        'updatedAt does not survive an ISO-8601 round trip: the column has sub-millisecond precision',
      );

      const rotated = await handlePutKeyRecord(
        {
          accountId: account.accountId,
          kind: 'passphrase',
          kdfDescriptor: { ...kdfDescriptor() },
          wrappedDek: new Uint8Array(Buffer.from(wrappedDek(), 'base64')),
          expectedUpdatedAt: new Date(wireToken),
        },
        store,
      );
      assert.equal(rotated.status, 'ok', 'a rotation using the round-tripped token was rejected');
      if (rotated.status !== 'ok') throw new Error('unreachable');
      assert.notEqual(
        rotated.record.updatedAt.getTime(),
        created.record.updatedAt.getTime(),
        'the rotation did not move the CAS token, so the same write could be replayed forever',
      );

      // THE STALE WRITE. The token the first read handed out is now spent, and
      // presenting it again is a device re-wrapping a DEK state that no longer
      // exists. Accepting it would overwrite the wrap another device just
      // committed and strand that device permanently.
      const stale = await handlePutKeyRecord(
        {
          accountId: account.accountId,
          kind: 'passphrase',
          kdfDescriptor: { ...kdfDescriptor() },
          wrappedDek: new Uint8Array(Buffer.from(wrappedDek(), 'base64')),
          expectedUpdatedAt: new Date(wireToken),
        },
        store,
      );
      assert.equal(stale.status, 'conflict', 'a stale compare-and-swap write was accepted');
      if (stale.status !== 'conflict') throw new Error('unreachable');
      assert.equal(
        stale.currentUpdatedAt?.getTime(),
        rotated.record.updatedAt.getTime(),
        'the conflict did not report the value the caller must re-read',
      );

      // The row was not touched by the refusal.
      const [live] = await store.listKeyRecords(account.accountId);
      assert.equal(
        Buffer.from(live?.wrappedDek ?? new Uint8Array()).toString('base64'),
        Buffer.from(rotated.record.wrappedDek).toString('base64'),
        'a refused CAS write changed the stored DEK',
      );
    },
  );
});
