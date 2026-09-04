/**
 * The password rule and the address normal form.
 *
 * ONE RULE, AND THE TESTS SAY SO. The cases below assert the floor and then
 * assert that nothing ELSE is refused: a composition rule that grew back would
 * fail the "accepts ten lower-case letters" case, which is the point.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { isAcceptablePassword, MIN_PASSWORD_LENGTH } from '../../../app/lib/auth/password-rule.ts';
import { normalizeEmail, parseEmail } from '../../../app/lib/auth/email.ts';

describe('the password rule', () => {
  it('refuses one character under the floor', () => {
    assert.equal(isAcceptablePassword('a'.repeat(MIN_PASSWORD_LENGTH - 1)), false);
  });

  it('accepts exactly the floor', () => {
    assert.equal(isAcceptablePassword('a'.repeat(MIN_PASSWORD_LENGTH)), true);
  });

  it('sets the floor at ten, which is what the screens tell a reader', () => {
    assert.equal(MIN_PASSWORD_LENGTH, 10);
  });

  it('asks for nothing but length', () => {
    // No digit, no symbol, no capital. A rule that grew back would fail here.
    assert.equal(isAcceptablePassword('abcdefghij'), true);
    assert.equal(isAcceptablePassword('           '), true);
  });

  it('refuses an empty password', () => {
    assert.equal(isAcceptablePassword(''), false);
  });
});

describe('the address normal form', () => {
  it('trims and lower-cases, because the unique index is over that form', () => {
    assert.equal(normalizeEmail('  Reader@Example.COM '), 'reader@example.com');
  });

  it('normalizes a valid address on the way through the parser', () => {
    assert.equal(parseEmail(' Reader@Example.com '), 'reader@example.com');
  });

  it('refuses something that is not an address', () => {
    assert.equal(parseEmail('reader'), null);
    assert.equal(parseEmail(''), null);
    assert.equal(parseEmail('reader@'), null);
  });
});
