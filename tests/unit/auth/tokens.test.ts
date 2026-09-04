/**
 * The mailed single-use tokens: what is minted, what is stored, and how long
 * each kind lives.
 *
 * WHY THESE ARE PURE. Token minting has no database in it on purpose: the row
 * write lives in `auth.server.ts` and the values it writes come from here. That
 * split is what lets the properties below be asserted at all, and the one that
 * matters most is that the DIGEST is what a caller stores, never the token.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { buildTokenUrl, expiryFor, generateToken, hashToken } from '../../../app/lib/auth/tokens.ts';

const HOUR_MS = 60 * 60 * 1000;

describe('token minting', () => {
  it('mints 32 bytes as 64 hex characters', () => {
    const token = generateToken();
    assert.match(token, /^[0-9a-f]{64}$/, 'a token is not 32 bytes of hex');
  });

  it('mints a different token every time', () => {
    const minted = new Set(Array.from({ length: 50 }, () => generateToken()));
    assert.equal(minted.size, 50, 'the minter repeated itself, so it is not reading the CSPRNG');
  });
});

describe('token hashing', () => {
  it('stores the SHA-256 digest, never the token', () => {
    const token = generateToken();
    const stored = hashToken(token);

    assert.equal(stored, createHash('sha256').update(token).digest('hex'));
    assert.notEqual(stored, token, 'the stored value IS the token, so a dumped table replays every link');
    assert.ok(!stored.includes(token.slice(0, 16)), 'the digest carries the token');
  });

  it('is deterministic, because a lookup is by digest', () => {
    const token = generateToken();
    assert.equal(hashToken(token), hashToken(token));
  });

  it('gives two tokens two digests', () => {
    assert.notEqual(hashToken(generateToken()), hashToken(generateToken()));
  });
});

describe('token lifetimes', () => {
  const now = new Date('2026-09-04T12:00:00.000Z');

  it('lets a confirmation link live a day, because it is opened on another device', () => {
    assert.equal(expiryFor({ kind: 'verify', now }).getTime() - now.getTime(), 24 * HOUR_MS);
  });

  it('lets a reset link live an hour, because a mailbox is what an attacker reaches', () => {
    assert.equal(expiryFor({ kind: 'reset', now }).getTime() - now.getTime(), HOUR_MS);
  });

  it('gives the reset link the shorter life of the two', () => {
    // The ORDERING is the rule, not the two numbers: a reset link restores a
    // login and a confirmation link only proves an address.
    assert.ok(expiryFor({ kind: 'reset', now }) < expiryFor({ kind: 'verify', now }));
  });
});

describe('the link a mail carries', () => {
  it('puts the token in the query string of an absolute URL', () => {
    const url = buildTokenUrl({ origin: 'https://translate.altan.fyi', path: '/verify-email', token: 'abc123' });

    assert.equal(url, 'https://translate.altan.fyi/verify-email?token=abc123');
  });

  it('escapes a token rather than pasting it in raw', () => {
    const url = buildTokenUrl({ origin: 'https://translate.altan.fyi', path: '/reset-password', token: 'a b&c' });

    assert.equal(new URL(url).searchParams.get('token'), 'a b&c', 'the token did not survive the round trip');
    assert.ok(!url.includes('&c='), 'an unescaped token split into a second query parameter');
  });
});
