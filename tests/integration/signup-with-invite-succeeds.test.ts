/**
 * The front door opens: a signup carrying a freshly minted invite creates an
 * account (M184 spec 03).
 *
 * WHY THIS IS THE MOST IMPORTANT CASE IN THE MILESTONE AFTER THE WALLET TEST
 *   Every other case here proves something is refused, and a gate that refuses
 *   everybody passes all of them. This is the only case that fails when the
 *   milestone ships a wall. The failure it exists to catch is not theoretical:
 *   spec 02 shipped the server gate, and the browser's signup body carried no
 *   token at all, so every real signup was already answering 403, the
 *   operator's own first one included.
 *
 * IT USES THE CLIENT'S OWN REQUEST BUILDER
 *   The body is built by `buildSignupRequest` from
 *   `app/components/account/sync-client.ts`, which is the function the setup
 *   screen calls, rather than by a literal written here. That is the whole
 *   point: a literal would prove the SERVICE accepts an invite, which
 *   `signup-requires-invite.test.ts` already covers, and would go on passing
 *   while the browser kept omitting the field. This asserts the two halves
 *   agree.
 *
 *   What is NOT exercised is the Argon2id derivation and the two key-record
 *   writes that follow the signup. Those need a browser (a Worker, WebCrypto,
 *   a session cookie round trip) and they are unchanged by this milestone. The
 *   hash below is a well-formed value no passphrase produced.
 *
 * ISOLATION
 *   One invite and one account, both created here and both deleted in
 *   `after()`, by id. The invites table is NOT assumed to be empty: this
 *   installation's dev database holds unrelated rows, and nothing here reads,
 *   counts or removes them.
 *
 * WHAT THIS FILE MUST NEVER PRINT
 *   No assertion message may carry the invite token or the auth hash. Both are
 *   bearer credentials, and a failing test's output ends up in a scrollback.
 *
 * THE PRECONDITION IS A REACHABLE DATABASE. `DB_HOST`, nothing else.
 */
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';

import { closePool, db, poolInitialized } from '../../drizzle/db';
import { accounts, invites } from '../../drizzle/schema';
import { CONFIG } from '../../app/config';
import { buildSignupRequest } from '../../app/components/account/sync-client';
import { handleSignup } from '../../app/lib/e2ee/auth-handlers';
import type { JsonValue } from '../../app/lib/e2ee/json';
import { createAuthContext } from '../../app/lib/e2ee/e2ee-context.server';
import { DEFAULT_ARGON2_PARAMS } from '../../app/lib/e2ee/kdf-descriptor';
import { computeInviteTokenHash, deriveInviteTokenPepper, generateInviteToken } from '../../app/lib/invites/token';

const DB_HOST = process.env.DB_HOST;

/** The pepper this installation actually uses, so a row minted here is one signup will accept. */
const invitePepper = deriveInviteTokenPepper(CONFIG.e2ee.serverSecret);

const createdAccountIds: number[] = [];
const createdInviteIds: number[] = [];

/** Mints one invite row and returns the plaintext, exactly as `pnpm cli account invite` does. */
async function mintInvite(): Promise<string> {
  const token = generateInviteToken();
  const [row] = await db
    .insert(invites)
    .values({ tokenHash: computeInviteTokenHash({ token, pepper: invitePepper }) })
    .returning({ id: invites.id });
  assert.ok(row, 'could not mint the invite');
  createdInviteIds.push(row.id);
  return token;
}

after(async () => {
  if (DB_HOST && createdAccountIds.length > 0) {
    await db.delete(accounts).where(inArray(accounts.id, createdAccountIds));
  }
  if (DB_HOST && createdInviteIds.length > 0) {
    // Separately, and by id: `redeemed_by_account_id` is `ON DELETE SET NULL`,
    // so these rows do not cascade with the account.
    await db.delete(invites).where(inArray(invites.id, createdInviteIds));
  }
  // THE POOL FINISHES OPENING BEFORE IT IS CLOSED. `drizzle/db.ts` kicks off
  // `ensureHostIndexes` behind `poolInitialized` at import time, and a short
  // test file can reach `closePool()` first, which turns a passing run into
  // "Cannot use a pool after calling end on the pool" reported as a failure.
  await poolInitialized;
  await closePool();
});

describe('signup with an invite', () => {
  it(
    'creates the account, through the body the browser actually builds',
    { skip: !DB_HOST ? 'DB_HOST not set' : false },
    async () => {
      const token = await mintInvite();
      const handle = `zzinvited-${randomUUID().slice(0, 8)}`;

      const body = buildSignupRequest({
        handle,
        authHash: randomBytes(32).toString('base64'),
        recoveryAuthHash: randomBytes(32).toString('base64'),
        kdfDescriptor: {
          salt: randomBytes(16).toString('base64'),
          params: {
            memorySizeKib: DEFAULT_ARGON2_PARAMS.memorySizeKib,
            iterations: DEFAULT_ARGON2_PARAMS.iterations,
            parallelism: DEFAULT_ARGON2_PARAMS.parallelism,
          },
        },
        inviteToken: token,
      });

      // ASSERTED BEFORE THE CALL, because this is the exact field that was
      // missing. Without it the signup below would be refused, and a reader
      // would be left guessing whether the invite, the handle or the hash was
      // the problem.
      assert.ok(
        'inviteToken' in body,
        'buildSignupRequest dropped the invite. The service refuses a signup without one, so a browser using ' +
          'this builder can never create an account, and the instance cannot be joined by anybody.',
      );

      // THROUGH JSON, AS THE WIRE WOULD CARRY IT. The handler takes a decoded
      // request body, which is what the round trip produces, and it is not the
      // client's typed structure. Passing the object straight in would let a
      // value that cannot survive serialization pass this test and fail in a
      // browser.
      const wire: JsonValue = JSON.parse(JSON.stringify(body));
      const outcome = await handleSignup(wire, createAuthContext());

      assert.equal(
        outcome.status,
        'created',
        `A signup carrying a freshly minted invite was answered '${outcome.status}'. This is the front door: ` +
          'if it is shut, the milestone has shipped an instance nobody can join.',
      );
      if (outcome.status !== 'created') throw new Error('unreachable');
      createdAccountIds.push(outcome.body.account.id);

      // THE ROW, NOT THE STATUS. A handler can report success and write
      // nothing, and the only thing that makes a person a reader of this app is
      // an `accounts` row they can sign in against.
      const stored = await db.query.accounts.findFirst({ where: eq(accounts.handle, handle) });
      assert.ok(stored, 'the signup reported success and no account row exists');
      assert.equal(stored.id, outcome.body.account.id);

      // AND THE INVITE IS SPENT. `redeemedAt` is the authoritative marker, not
      // the account reference beside it, which is `ON DELETE SET NULL` and
      // would hand a spent token a second life when an account is deleted.
      const redeemed = await db.query.invites.findFirst({
        where: inArray(invites.id, createdInviteIds),
      });
      assert.ok(redeemed?.redeemedAt, 'the account was created and the invite was left unspent, so it can be reused');
    },
  );
});
