/**
 * A reader who already holds an account does not get the account-creation form
 * (M189).
 *
 * WHY THIS CASE EXISTS
 *   `/sign-up` and `/sign-in` are public, and they must stay public: a gate in
 *   front of the sign-in page is a gate nobody can ever pass. That correct rule
 *   left a wrong screen behind. A signed-in reader following an old bookmark,
 *   or pressing back after finishing setup, was handed a form offering them a
 *   SECOND account, with a new sign-in name and a new recovery code that would
 *   displace the ones they had just been told to save. Nothing in a typecheck,
 *   a lint or a status assertion can see that.
 *
 * IT DRIVES THE REAL LOADERS WITH A REAL SESSION COOKIE. The account is created
 * through `handleSignup`, the cookie is sealed by `commitAccountSession`, which
 * is the same function the browser's sign-up path uses, and the loaders are
 * imported from the route files. A hand-built cookie would prove only that this
 * file can write a header.
 *
 * THE REFUSAL IS A REDIRECT, WHICH A LOADER THROWS. So each case catches, and
 * asserts that what it caught is a `Response` with a `location`. `assert.throws`
 * would pass on any thrown value, including the failure this is looking for.
 *
 * AND ONE CASE HOLDS THE DOOR OPEN. Asserting two redirects is satisfied by a
 * pair of loaders that redirect everybody, which would lock every new reader
 * out of the only screen that can admit them. The last case is the signed-out
 * stranger, and it asserts they still get the form.
 *
 * ISOLATION. One invite and one account, both created here and both deleted in
 * `after()`, by id. Nothing else in either table is read, counted or removed.
 *
 * WHAT THIS FILE MUST NEVER PRINT. No assertion message may carry the invite
 * token, the auth hash or the session cookie. All three are bearer credentials.
 *
 * THE PRECONDITION IS A REACHABLE DATABASE. `DB_HOST`, nothing else.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { inArray } from 'drizzle-orm';
import { RouterContextProvider } from 'react-router';

import { closePool, db, poolInitialized } from '../../drizzle/db';
import { accounts, invites } from '../../drizzle/schema';
import { CONFIG } from '../../app/config';
import { handleSignup } from '../../app/lib/e2ee/auth-handlers';
import type { JsonValue } from '../../app/lib/e2ee/json';
import { createAuthContext } from '../../app/lib/e2ee/e2ee-context.server';
import { DEFAULT_ARGON2_PARAMS } from '../../app/lib/e2ee/kdf-descriptor';
import { computeInviteTokenHash, deriveInviteTokenPepper, generateInviteToken } from '../../app/lib/invites/token';
import { commitAccountSession } from '../../app/services/account-session.server';
import { loader as signUpLoader } from '../../app/routes/sign-up';
import { loader as signInLoader } from '../../app/routes/sign-in';

const DB_HOST = process.env.DB_HOST;

const createdAccountIds: number[] = [];
const createdInviteIds: number[] = [];

/** The `name=value` pair of a signed session cookie holding a live account, or `null` before `before()` has run. */
let sessionCookie: string | null = null;

/** Mints one invite row and returns the plaintext, exactly as `pnpm cli account invite` does. */
async function mintInvite(): Promise<string> {
  const pepper = deriveInviteTokenPepper(CONFIG.e2ee.serverSecret);
  const token = generateInviteToken();
  const [row] = await db
    .insert(invites)
    .values({ tokenHash: computeInviteTokenHash({ token, pepper }) })
    .returning({ id: invites.id });
  assert.ok(row, 'could not mint the invite');
  createdInviteIds.push(row.id);
  return token;
}

/**
 * One real account, signed in.
 *
 * The hash below is a well-formed value no password produced: the Argon2id
 * derivation needs a browser, and it is not what these cases are about.
 */
async function signUpAndSealCookie(): Promise<string> {
  const wire: JsonValue = {
    handle: `zzsignedin-${randomUUID().slice(0, 8)}`,
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
    inviteToken: await mintInvite(),
  };

  const outcome = await handleSignup(wire, createAuthContext());
  assert.equal(outcome.status, 'created', `the fixture account was refused with '${outcome.status}'`);
  if (outcome.status !== 'created') throw new Error('unreachable');
  createdAccountIds.push(outcome.body.account.id);

  const setCookie = await commitAccountSession({
    request: new Request('https://translate.altan.fyi/sign-up'),
    tokens: outcome.body.tokens,
    account: outcome.body.account,
  });
  // The attributes after the first `;` are the browser's business. What travels
  // back in a `Cookie` header is the pair.
  const [pair] = setCookie.split(';');
  assert.ok(pair, 'the session cookie came back empty');
  return pair;
}

/** The arguments the router hands a loader, for one URL and one optional cookie. */
function loaderArgs(input: { url: string; pattern: string; cookie: string | null }) {
  const request = new Request(input.url, {
    headers: input.cookie === null ? undefined : { cookie: input.cookie },
  });
  return {
    request,
    url: new URL(request.url),
    params: {},
    pattern: input.pattern,
    context: new RouterContextProvider(),
  };
}

/**
 * The `Response` a loader threw, or a failure naming what it threw instead.
 *
 * Generic over the loader's own answer rather than taking `unknown`, so the
 * failure message below prints the data a non-redirecting loader returned.
 */
async function catchThrownResponse<TAnswer>(run: () => Promise<TAnswer>): Promise<Response> {
  try {
    const answered = await run();
    assert.fail(`the loader answered instead of redirecting: ${JSON.stringify(answered)}`);
  } catch (cause) {
    if (cause instanceof Response) return cause;
    throw cause;
  }
}

before(async () => {
  if (!DB_HOST) return;
  sessionCookie = await signUpAndSealCookie();
});

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

describe('the doors, for somebody who is already through them', () => {
  it(
    'sends a signed-in reader from /sign-up to /account',
    { skip: !DB_HOST ? 'DB_HOST not set' : false },
    async () => {
      const response = await catchThrownResponse(() =>
        signUpLoader(loaderArgs({ url: 'https://translate.altan.fyi/sign-up', pattern: '/sign-up', cookie: sessionCookie })),
      );

      assert.equal(response.status, 302);
      assert.equal(
        response.headers.get('location'),
        '/account',
        'A reader holding an account was left on the creation form. Finishing it would mint them a second ' +
          'sign-in name and a second recovery code, and displace the ones they were just told to save.',
      );
    },
  );

  it(
    'sends a signed-in reader from /sign-in to /account',
    { skip: !DB_HOST ? 'DB_HOST not set' : false },
    async () => {
      const response = await catchThrownResponse(() =>
        signInLoader(loaderArgs({ url: 'https://translate.altan.fyi/sign-in', pattern: '/sign-in', cookie: sessionCookie })),
      );

      assert.equal(response.status, 302);
      assert.equal(response.headers.get('location'), '/account');
    },
  );

  it(
    'still gives a stranger both forms',
    { skip: !DB_HOST ? 'DB_HOST not set' : false },
    async () => {
      // WITHOUT THIS CASE THE TWO ABOVE ARE SATISFIED BY A PAIR OF LOADERS THAT
      // REDIRECT EVERYBODY, which is an instance nobody can join.
      const signUpData = await signUpLoader(
        loaderArgs({ url: 'https://translate.altan.fyi/sign-up?invite=zz-not-a-real-token', pattern: '/sign-up', cookie: null }),
      );
      assert.ok(
        !(signUpData instanceof Response),
        'A signed-out stranger was redirected away from the account-creation form, so this instance cannot be joined.',
      );
      assert.equal(signUpData.invite, 'zz-not-a-real-token', 'the invite in the URL did not reach the form');

      const signInData = await signInLoader(
        loaderArgs({ url: 'https://translate.altan.fyi/sign-in', pattern: '/sign-in', cookie: null }),
      );
      assert.equal(signInData, null, 'a signed-out visitor was turned away from the sign-in form');
    },
  );
});
