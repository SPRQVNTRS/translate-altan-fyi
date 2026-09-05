/**
 * The whole way in: sign up, get the mail, click the link, sign in, hold a
 * session.
 *
 * WHY THIS IS ONE CASE AND NOT FIVE. Each step is already covered on its own,
 * and every one of them can pass while the chain is broken: `registerUser`
 * writing a row nobody can confirm, a token minted under one `kind` and read
 * under another, `signIn` refusing a user it just confirmed, a cookie the
 * middleware will not accept. The defect this closes is an account a person can
 * create and never open, which is exactly what a green gate shipped before.
 *
 * THE TOKEN IS READ OUT OF THE MAIL, not out of the database. A test that
 * queried `user_tokens` for the digest would pass even if the mail were empty,
 * and the mail is the only copy of the raw value that exists.
 *
 * THE NON-DISCLOSURE RULES ARE ASSERTED HERE TOO, because they are properties
 * of the pair of answers rather than of either one: a second sign-up for the
 * same address and a sign-up for a new one must be indistinguishable, and an
 * unknown address, a wrong password and an unconfirmed address must all refuse
 * the same way.
 *
 * ISOLATION. Every user this file creates is deleted by id in `after()`. Token
 * rows and blobs cascade with them.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { eq } from 'drizzle-orm';

import { closePool, db, poolInitialized } from '../../drizzle/db';
import { users } from '../../drizzle/schema';
import { resolveUser } from '../../app/middleware/auth';
import { registerUser, signIn, verifyEmailToken } from '../../app/services/auth.server';
import { getServerT } from '../../app/emails/i18n.server';
import { DEFAULT_LANGUAGE } from '../../app/i18n/language-prefs';
import { commitUserSession } from '../../app/services/session.server';
import {
  createMemoryTransport,
  setTransportForTests,
  type MemoryTransport,
} from '../../app/services/email.server';

/**
 * Every case self-skips on this, INLINE rather than through a shared constant.
 * `tests/unit/integration-tests-self-skip.test.ts` reads the source text and
 * wants the precondition visible at the case, because a guard hidden behind a
 * name is a guard the next reader deletes without noticing.
 */
const DB_HOST = process.env.DB_HOST;

const ORIGIN = 'https://kenning.altan.fyi';
const PASSWORD = 'a long enough password';

const createdEmails: string[] = [];
let transport: MemoryTransport;

/** A fresh address per case. `.invalid` is reserved by the RFC, so nothing here can ever reach a real inbox. */
function freshEmail(label: string): string {
  const email = `zzsignup-${label}-${Date.now()}-${createdEmails.length}@example.invalid`;
  createdEmails.push(email);
  return email;
}


/**
 * The mail context a route hands the service: a real translator for the repo's
 * default language, not a stub. The copy is irrelevant to these cases; that the
 * templates can RENDER is not, and a stub would hide a missing key.
 */
const mail = { t: getServerT(DEFAULT_LANGUAGE), origin: ORIGIN };

/** The token out of the last captured mail, read the way a mail client reads it. */
function tokenFromLastMail(): string {
  const last = transport.messages.at(-1);
  assert.ok(last, 'no mail was sent at all');
  const match = /https?:\/\/\S+/.exec(last.text);
  assert.ok(match, `no link in the mail body:\n${last.text}`);
  const token = new URL(match[0]).searchParams.get('token');
  assert.ok(token, 'the mailed link carries no token');
  return token;
}

/** A request carrying the cookie a `Set-Cookie` header just handed out, which is what the browser sends back. */
function requestWithCookie(setCookie: string): Request {
  return new Request(`${ORIGIN}/account`, { headers: { cookie: setCookie.split(';')[0] ?? '' } });
}

before(() => {
  transport = createMemoryTransport();
  setTransportForTests(transport);
});

after(async () => {
  setTransportForTests(null);
  for (const email of createdEmails) {
    await db.delete(users).where(eq(users.email, email));
  }
  await poolInitialized;
  await closePool();
});

describe('sign up, confirm, sign in', () => {
  it('walks a stranger from an empty form to a usable session', { skip: !DB_HOST ? 'DB_HOST not set' : false }, async () => {
    const email = freshEmail('happy');
    transport.clear();

    const registered = await registerUser({ email, password: PASSWORD, mail });
    assert.deepEqual(registered, { status: 'mailed' });
    assert.equal(transport.messages.length, 1, 'sign-up sent no confirmation mail');
    assert.equal(transport.messages[0]?.to, email);

    // Before the link is clicked the account exists and cannot be used. The
    // answer is `unconfirmed` rather than a refusal, BECAUSE THE PASSWORD IS
    // RIGHT: the screen turns that into "confirm your email first" plus a
    // resend button, and it reveals nothing the password did not already prove.
    assert.deepEqual(
      await signIn({ email, password: PASSWORD }),
      { status: 'unconfirmed' },
      'an unconfirmed account did not get the confirm-your-email answer',
    );

    const confirmed = await verifyEmailToken(tokenFromLastMail());
    assert.equal(confirmed.status, 'ok');

    const attempt = await signIn({ email, password: PASSWORD });
    assert.equal(attempt.status, 'ok', 'a confirmed account could not sign in');
    const user = attempt.status === 'ok' ? attempt.user : null;
    assert.ok(user);
    assert.equal(user.email, email);

    // The session the sign-in route would set, read back by the middleware that
    // guards every gated screen.
    const setCookie = await commitUserSession({ request: new Request(`${ORIGIN}/sign-in`), userId: user.id });
    const resolved = await resolveUser(requestWithCookie(setCookie));
    assert.equal(resolved?.id, user.id);
    assert.equal(resolved?.isSuperadmin, false, 'a new account arrived with the superadmin flag set');
  });

  it('answers a second sign-up for the same address exactly as it answers a first', { skip: !DB_HOST ? 'DB_HOST not set' : false }, async () => {
    const known = freshEmail('known');
    const stranger = freshEmail('stranger');

    await registerUser({ email: known, password: PASSWORD, mail });
    await verifyEmailToken(tokenFromLastMail());

    // A confirmed address and an address nobody has ever used. If these two
    // answers differed, this form would be a list of who holds an account.
    const second = await registerUser({ email: known, password: PASSWORD, mail });
    const first = await registerUser({ email: stranger, password: PASSWORD, mail });
    assert.deepEqual(second, first);
    assert.deepEqual(second, { status: 'mailed' });
  });

  it('refuses an unknown address and a wrong password identically', { skip: !DB_HOST ? 'DB_HOST not set' : false }, async () => {
    const unconfirmed = freshEmail('unconfirmed');
    const confirmed = freshEmail('confirmed');

    await registerUser({ email: unconfirmed, password: PASSWORD, mail });
    await registerUser({ email: confirmed, password: PASSWORD, mail });
    await verifyEmailToken(tokenFromLastMail());

    // THE PAIR THAT MUST BE INDISTINGUISHABLE: an address nobody holds, and one
    // that is on file with the wrong password. If these two differed, the form
    // would be a list of who holds an account.
    const [unknownAddress, wrongPassword] = await Promise.all([
      signIn({ email: 'zznobody@example.invalid', password: PASSWORD }),
      signIn({ email: confirmed, password: 'the wrong password entirely' }),
    ]);
    assert.deepEqual(unknownAddress, wrongPassword);
    assert.deepEqual(unknownAddress, { status: 'refused' });

    // A WRONG password on the UNCONFIRMED address must read the same way too.
    // Answering `unconfirmed` here would be the oracle: it would name an
    // address on file to somebody who only guessed at it.
    assert.deepEqual(
      await signIn({ email: unconfirmed, password: 'also the wrong password' }),
      { status: 'refused' },
      'a wrong password on an unconfirmed address disclosed that the address exists',
    );

    // The contrast case. Without it the assertions above would pass on a build
    // where `signIn` refuses everybody.
    assert.equal((await signIn({ email: confirmed, password: PASSWORD })).status, 'ok', 'nothing can sign in at all');
  });

  it('refuses a password under the floor, and creates nothing', { skip: !DB_HOST ? 'DB_HOST not set' : false }, async () => {
    const email = freshEmail('short');
    const refused = await registerUser({ email, password: 'short', mail });
    assert.deepEqual(refused, { status: 'invalid-password' });

    const row = await db.query.users.findFirst({ where: eq(users.email, email) });
    assert.equal(row, undefined, 'a refused sign-up still wrote a user row');
  });

  it('spends a confirmation link once', { skip: !DB_HOST ? 'DB_HOST not set' : false }, async () => {
    const email = freshEmail('twice');
    await registerUser({ email, password: PASSWORD, mail });
    const token = tokenFromLastMail();

    assert.equal((await verifyEmailToken(token)).status, 'ok');
    assert.equal((await verifyEmailToken(token)).status, 'invalid');
  });
});
