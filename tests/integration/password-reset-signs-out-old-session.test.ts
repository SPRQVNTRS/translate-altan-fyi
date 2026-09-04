/**
 * A password change is a session epoch, proved against the real column.
 *
 * THE PROPERTY. `users.password_changed_at` is compared against the cookie's
 * `issuedAt` on every request, and that comparison is the entire mechanism by
 * which a reset signs a stolen device out. There is no session table to sweep,
 * so nothing else in the system can be inspected to see whether it worked: the
 * only honest test is two live cookies, a reset on one of them, and a check
 * that the other one stops being accepted.
 *
 * THE OTHER HALF IS AS LOAD BEARING AS THE FIRST. The tab that made the change
 * must SURVIVE it. `resetPassword` and `changePassword` both hand back a fresh
 * `Set-Cookie` for exactly that reason, and a caller that drops it signs the
 * reader out of the browser they just proved themselves in. So each case here
 * asserts both directions: the other device dies, this one lives.
 *
 * WHY THE FIXTURE READS `password_changed_at` BACK. The column is set from the
 * DATABASE clock when the row is inserted, and the sessions are minted from the
 * NODE clock, so a cookie stamped "a second ago" to look realistic is already
 * older than the account it belongs to and is refused before anything under
 * test has happened. The two devices here are therefore issued at exactly the
 * instant the column holds, which is what a real sign-in produces: a session no
 * older than the password it was opened with.
 *
 * ISOLATION. Every user is deleted by id in `after()`.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { eq } from 'drizzle-orm';

import { closePool, db, poolInitialized } from '../../drizzle/db';
import { users } from '../../drizzle/schema';
import { resolveUser } from '../../app/middleware/auth';
import {
  changePassword,
  registerUser,
  requestPasswordReset,
  resetPassword,
  signIn,
  verifyEmailToken,
} from '../../app/services/auth.server';
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

const ORIGIN = 'https://translate.altan.fyi';
const OLD_PASSWORD = 'the first long password';
const NEW_PASSWORD = 'the second long password';

const createdEmails: string[] = [];
let transport: MemoryTransport;

/**
 * The mail context a route hands the service: a real translator for the repo's
 * default language, not a stub. The copy is irrelevant to these cases; that the
 * templates can RENDER is not, and a stub would hide a missing key.
 */
const mail = { t: getServerT(DEFAULT_LANGUAGE), origin: ORIGIN };

function freshEmail(label: string): string {
  const email = `zzreset-${label}-${Date.now()}-${createdEmails.length}@example.invalid`;
  createdEmails.push(email);
  return email;
}

function tokenFromLastMail(): string {
  const last = transport.messages.at(-1);
  assert.ok(last, 'no mail was sent at all');
  const match = /https?:\/\/\S+/.exec(last.text);
  assert.ok(match, `no link in the mail body:\n${last.text}`);
  const token = new URL(match[0]).searchParams.get('token');
  assert.ok(token, 'the mailed link carries no token');
  return token;
}

/** A request carrying one cookie, which is what a browser sends back. */
function requestWithCookie(setCookie: string): Request {
  return new Request(`${ORIGIN}/lists`, { headers: { cookie: setCookie.split(';')[0] ?? '' } });
}

/** A confirmed, signed-in user, plus two cookies at the account's current epoch, standing for two devices. */
async function seedSignedInUser(label: string): Promise<{ id: number; email: string; devices: string[] }> {
  const email = freshEmail(label);
  await registerUser({ email, password: OLD_PASSWORD, mail });
  await verifyEmailToken(tokenFromLastMail());

  const attempt = await signIn({ email, password: OLD_PASSWORD });
  assert.equal(attempt.status, 'ok', 'the fixture user could not sign in');
  const user = attempt.status === 'ok' ? attempt.user : null;
  assert.ok(user);

  // The account's current epoch, from the row rather than from this process's
  // clock. See the module header.
  const row = await db.query.users.findFirst({ where: eq(users.id, user.id) });
  assert.ok(row, 'the fixture user disappeared between sign-in and session');
  const issuedAt = row.passwordChangedAt;

  const devices = await Promise.all([
    commitUserSession({ request: new Request(`${ORIGIN}/sign-in`), userId: user.id, issuedAt }),
    commitUserSession({ request: new Request(`${ORIGIN}/sign-in`), userId: user.id, issuedAt }),
  ]);
  return { id: user.id, email, devices };
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

describe('a reset ends the other sessions', () => {
  it('kills the other device and keeps the one that reset', { skip: !DB_HOST ? 'DB_HOST not set' : false }, async () => {
    const account = await seedSignedInUser('two-devices');
    const [phone, laptop] = account.devices;
    assert.ok(phone !== undefined && laptop !== undefined);

    // Both are live before the reset. Without this the assertion below would
    // pass on a build where no cookie ever worked.
    assert.equal((await resolveUser(requestWithCookie(phone)))?.id, account.id);
    assert.equal((await resolveUser(requestWithCookie(laptop)))?.id, account.id);

    await requestPasswordReset({ email: account.email, mail });
    const result = await resetPassword({
      rawToken: tokenFromLastMail(),
      password: NEW_PASSWORD,
      request: requestWithCookie(laptop),
    });
    assert.equal(result.status, 'ok');
    assert.ok(result.status === 'ok' && result.setCookie !== '', 'the reset handed back no fresh cookie');

    // The device that was not there is out, cookie and all.
    assert.equal(await resolveUser(requestWithCookie(phone)), null, 'the other device survived the reset');
    assert.equal(await resolveUser(requestWithCookie(laptop)), null, 'the OLD cookie of the resetting tab survived');

    // And the cookie the reset handed back is the one that still works.
    const fresh = result.status === 'ok' ? result.setCookie : '';
    assert.equal((await resolveUser(requestWithCookie(fresh)))?.id, account.id);
  });

  it('replaces the password rather than adding one', { skip: !DB_HOST ? 'DB_HOST not set' : false }, async () => {
    const account = await seedSignedInUser('replaced');
    await requestPasswordReset({ email: account.email, mail });
    await resetPassword({
      rawToken: tokenFromLastMail(),
      password: NEW_PASSWORD,
      request: new Request(`${ORIGIN}/reset-password`),
    });

    assert.deepEqual(
      await signIn({ email: account.email, password: OLD_PASSWORD }),
      { status: 'refused' },
      'the old password still works',
    );
    assert.equal(
      (await signIn({ email: account.email, password: NEW_PASSWORD })).status,
      'ok',
      'the new password does not work',
    );
  });

  it('spends a reset link once, so two clicks cannot set two passwords', { skip: !DB_HOST ? 'DB_HOST not set' : false }, async () => {
    const account = await seedSignedInUser('once');
    await requestPasswordReset({ email: account.email, mail });
    const token = tokenFromLastMail();

    const first = await resetPassword({
      rawToken: token,
      password: NEW_PASSWORD,
      request: new Request(`${ORIGIN}/reset-password`),
    });
    const second = await resetPassword({
      rawToken: token,
      password: 'a third long password entirely',
      request: new Request(`${ORIGIN}/reset-password`),
    });

    assert.equal(first.status, 'ok');
    assert.deepEqual(second, { status: 'invalid-token' });
    assert.equal(
      (await signIn({ email: account.email, password: NEW_PASSWORD })).status,
      'ok',
      'the first reset did not stick',
    );
  });

  it('mails nothing for an address nobody holds, and says so either way', { skip: !DB_HOST ? 'DB_HOST not set' : false }, async () => {
    const account = await seedSignedInUser('unknown-address');
    transport.clear();

    const known = await requestPasswordReset({ email: account.email, mail });
    const sentForKnown = transport.messages.length;
    const unknown = await requestPasswordReset({ email: 'zznobody@example.invalid', mail });

    assert.deepEqual(known, unknown, 'the two answers differ, so this form is an enumeration oracle');
    assert.equal(sentForKnown, 1, 'a known address was mailed nothing');
    assert.equal(transport.messages.length, 1, 'an unknown address was mailed something');
  });
});

describe('a password change keeps its own tab signed in', () => {
  it('hands back a cookie that still works while the other device is out', { skip: !DB_HOST ? 'DB_HOST not set' : false }, async () => {
    const account = await seedSignedInUser('changed');
    const [phone, laptop] = account.devices;
    assert.ok(phone !== undefined && laptop !== undefined);

    const changed = await changePassword({
      userId: account.id,
      current: OLD_PASSWORD,
      next: NEW_PASSWORD,
      request: requestWithCookie(laptop),
    });
    assert.equal(changed.status, 'ok');

    const fresh = changed.status === 'ok' ? changed.setCookie : '';
    assert.equal((await resolveUser(requestWithCookie(fresh)))?.id, account.id, 'the changing tab was signed out');
    assert.equal(await resolveUser(requestWithCookie(phone)), null, 'the other device survived the change');
  });

  it('refuses a wrong current password and changes nothing', { skip: !DB_HOST ? 'DB_HOST not set' : false }, async () => {
    const account = await seedSignedInUser('wrong-current');
    const [phone] = account.devices;
    assert.ok(phone !== undefined);

    const refused = await changePassword({
      userId: account.id,
      current: 'not the current password',
      next: NEW_PASSWORD,
      request: new Request(`${ORIGIN}/account`),
    });

    assert.deepEqual(refused, { status: 'wrong-password' });
    assert.equal(
      (await signIn({ email: account.email, password: OLD_PASSWORD })).status,
      'ok',
      'the old password stopped working',
    );
    assert.equal((await resolveUser(requestWithCookie(phone)))?.id, account.id, 'a refused change signed a device out');
  });
});
