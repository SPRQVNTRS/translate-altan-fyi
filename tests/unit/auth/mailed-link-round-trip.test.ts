/**
 * The mailed link, from the moment it is minted to the moment it is clicked.
 *
 * WHAT THIS COVERS THAT NOTHING ELSE DOES. Four separate pieces have to agree
 * for a confirmation or a reset to work at all: `generateToken` mints a value,
 * `buildTokenUrl` puts it in a URL, a template drops that URL into a body, and
 * a route pulls it back out of `?token=`. Each of those is tested on its own
 * elsewhere, and each of them can be individually correct while the chain is
 * broken, which is the failure mode that ships an account nobody can open. So
 * this walks the whole chain and ends where the route starts: at
 * `hashToken(fromTheUrl)`, the value the database is actually queried by.
 *
 * IT NEEDS NO DATABASE, ON PURPOSE. The pre-push gate runs the unit suite with
 * nothing running behind it, so the pieces that talk to Postgres are covered by
 * `tests/integration/signup-verify-signin.test.ts` and its neighbours. What is
 * left here is the part that a typecheck cannot see and a database would only
 * slow down.
 *
 * THE TRANSPORT IS THE MEMORY ONE, installed and removed per case, so a mail
 * that a template renders is a mail this file can read rather than one that
 * escapes to a real inbox.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { resetPasswordTemplate } from '#app/emails/reset-password';
import { verifyEmailTemplate } from '#app/emails/verify-email';
import type { JsonObject, JsonValue } from '#app/lib/json';
import { buildTokenUrl, expiryFor, generateToken, hashToken } from '#app/lib/auth/tokens';
import enCommon from '#app/locales/en/common.json';
import deCommon from '#app/locales/de/common.json';
import { createMemoryTransport, sendMail, setTransportForTests, type MemoryTransport } from '#app/services/email.server';

const ORIGIN = 'https://kenning.altan.fyi';
const READER = 'reader@example.com';

/** The catalogues, keyed the way the templates ask for them: one flat lookup per language. */
const CATALOGS = { en: flatten(enCommon), de: flatten(deCommon) };

/** A `t` bound to one language, the same shape `requestT` hands the templates. */
function translatorFor(language: 'en' | 'de'): (key: string) => string {
  const catalog = CATALOGS[language];
  return (key: string) => {
    const value = catalog.get(key);
    assert.ok(value !== undefined, `no copy for ${key} in ${language}`);
    return value;
  };
}

/** A nested catalogue as `a.b.c` keys, which is how i18next addresses it. */
function flatten(node: JsonObject, prefix = ''): Map<string, string> {
  const out = new Map<string, string>();
  for (const [key, value] of Object.entries(node)) {
    const path = `${prefix}${key}`;
    if (isNested(value)) {
      for (const [nested, nestedValue] of flatten(value, `${path}.`)) out.set(nested, nestedValue);
      continue;
    }
    out.set(path, String(value));
  }
  return out;
}

/** Whether a catalogue node is a sub-namespace rather than a string. */
function isNested(value: JsonValue): value is JsonObject {
  return value !== null && !Array.isArray(value) && value instanceof Object;
}

/**
 * The token a reader's browser would send, read out of the mail body the way a
 * mail client reads it: find the URL, open it, take `?token=`.
 *
 * It deliberately does NOT reuse the value that was minted. Reading it back out
 * of the rendered text is the entire point: a template that dropped the link,
 * wrapped it, or escaped it fails here.
 */
function tokenFromMailBody(text: string): string {
  const match = /https?:\/\/\S+/.exec(text);
  assert.ok(match, `no link in the mail body:\n${text}`);
  return new URL(match[0]).searchParams.get('token') ?? '';
}

let transport: MemoryTransport;

describe('a mailed link, minted to clicked', () => {
  beforeEach(() => {
    transport = createMemoryTransport();
    setTransportForTests(transport);
  });

  afterEach(() => {
    setTransportForTests(null);
  });

  for (const language of ['en', 'de'] as const) {
    it(`carries the confirmation token through the ${language} mail unchanged`, async () => {
      const token = generateToken();
      const url = buildTokenUrl({ origin: ORIGIN, path: '/verify-email', token });
      const message = verifyEmailTemplate(translatorFor(language), { url });

      await sendMail({ to: READER, subject: message.subject, text: message.text });

      const [captured] = transport.messages;
      assert.ok(captured, 'the transport captured no mail at all');
      assert.equal(captured.to, READER);
      assert.notEqual(captured.subject, '', 'the subject line is empty');

      // The route hashes what arrives in the query string and looks the row up
      // by that digest, so this is the comparison the database performs.
      assert.equal(hashToken(tokenFromMailBody(captured.text)), hashToken(token));
    });

    it(`carries the reset token through the ${language} mail unchanged`, async () => {
      const token = generateToken();
      const url = buildTokenUrl({ origin: ORIGIN, path: '/reset-password', token });
      const message = resetPasswordTemplate(translatorFor(language), { url });

      await sendMail({ to: READER, subject: message.subject, text: message.text });

      const [captured] = transport.messages;
      assert.ok(captured, 'the transport captured no mail at all');
      assert.equal(hashToken(tokenFromMailBody(captured.text)), hashToken(token));
    });
  }

  it('sends the link to the address that asked, and to nobody else', async () => {
    const url = buildTokenUrl({ origin: ORIGIN, path: '/verify-email', token: generateToken() });
    const message = verifyEmailTemplate(translatorFor('en'), { url });

    await sendMail({ to: READER, subject: message.subject, text: message.text });
    await sendMail({ to: 'second@example.com', subject: message.subject, text: message.text });

    assert.deepEqual(
      transport.messages.map((mail) => mail.to),
      [READER, 'second@example.com'],
    );
  });

  it('mints a different token every time, so one mail never opens another reader account', () => {
    const minted = new Set(Array.from({ length: 50 }, () => generateToken()));
    assert.equal(minted.size, 50);
  });

  it('lands both links on the paths the routes are registered at', () => {
    const verify = buildTokenUrl({ origin: ORIGIN, path: '/verify-email', token: 'abc' });
    const reset = buildTokenUrl({ origin: ORIGIN, path: '/reset-password', token: 'abc' });
    assert.equal(new URL(verify).pathname, '/verify-email');
    assert.equal(new URL(reset).pathname, '/reset-password');
  });

  it('gives the reset link a shorter life than the confirmation link', () => {
    // Not a style preference: a reset link is the one that can take an account
    // over, so it is the one that must stop working sooner.
    const now = new Date('2026-09-04T12:00:00.000Z');
    const verifyExpiry = expiryFor({ kind: 'verify', now }).getTime();
    const resetExpiry = expiryFor({ kind: 'reset', now }).getTime();
    assert.ok(resetExpiry > now.getTime(), 'a reset link expires before it is even sent');
    assert.ok(resetExpiry < verifyExpiry, 'a reset link outlives a confirmation link');
  });

  it('reads no token out of a body whose link was mangled (guards the reader itself)', () => {
    // A test that could not fail is worse than no test: this proves the
    // extraction above is really reading the rendered text.
    assert.equal(tokenFromMailBody('Open https://kenning.altan.fyi/verify-email'), '');
  });
});
