/**
 * The pure half of the invite gate: what a minted invite token looks like, and
 * what the only stored form of it is.
 *
 * WHAT THIS FILE HOLDS IN PLACE
 *   The one property the whole scheme rests on is that the value written to
 *   `invites.token_hash` is NOT the value handed to a person. If those two ever
 *   coincided, a database dump would be a stack of working signup credentials
 *   and ADR-0009's entire argument would be false, while every other test in
 *   this repo stayed green. The first case below asserts exactly that
 *   difference rather than asserting that some hashing happened.
 *
 *   The pepper is asserted to be DOMAIN-SEPARATED from the verifier pepper.
 *   `server-secrets.ts` derives its subkeys from the same root secret this
 *   module does, so "we used a separate label" is only a claim until the two
 *   outputs are compared. A regression that reached for `verifierPepper` here
 *   would produce a perfectly working invite gate whose hashes are keyed with
 *   the material behind every account verifier.
 *
 *   Determinism is asserted because a stored hash has to stay checkable across
 *   restarts, and uniqueness is asserted because two invites sharing a token
 *   would collide on the unique index and let one redeem the other's row.
 *
 * NO DATABASE, NO ENVIRONMENT. `app/lib/invites/token.ts` is pure by design,
 * exactly so this file can exist in the unit tier.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { deriveServerSecrets } from '#app/lib/e2ee/server-secrets';
import { SIGNUP_INVITE_TOKEN_PREFIX, isSignupInviteToken } from '#app/lib/e2ee/tokens';
import {
  INVITE_TOKEN_PEPPER_LABEL,
  computeInviteTokenHash,
  deriveInviteTokenPepper,
  generateInviteToken,
  inviteTokenHashMatches,
} from '#app/lib/invites/token';

const ROOT_SECRET = 'a-test-root-secret-not-used-anywhere-real';

describe('invite tokens', () => {
  it('stores a hash that is not the token that was handed out', () => {
    const token = generateInviteToken();
    const hash = computeInviteTokenHash({ token, pepper: deriveInviteTokenPepper(ROOT_SECRET) });

    assert.notEqual(hash, token);
    // Stronger than inequality: the plaintext must not be RECOVERABLE from, or
    // even present in, the stored value.
    assert.ok(!hash.includes(token.slice(SIGNUP_INVITE_TOKEN_PREFIX.length)));
    assert.match(hash, /^[a-f0-9]{64}$/);
  });

  it('mints a token the existing shape gate recognises', () => {
    const token = generateInviteToken();

    assert.ok(isSignupInviteToken(token));
    assert.match(token, /^si_[a-f0-9]{64}$/);
  });

  it('never mints the same token twice', () => {
    const minted = new Set(Array.from({ length: 200 }, () => generateInviteToken()));

    assert.equal(minted.size, 200);
  });

  it('keys the hash with a subkey that is not the verifier pepper', () => {
    const invitePepper = deriveInviteTokenPepper(ROOT_SECRET);
    const { verifierPepper, enumerationSecret } = deriveServerSecrets(ROOT_SECRET);

    assert.notEqual(invitePepper, verifierPepper);
    assert.notEqual(invitePepper, enumerationSecret);
    assert.notEqual(invitePepper, ROOT_SECRET);
    assert.equal(INVITE_TOKEN_PEPPER_LABEL, 'translate-altan-fyi:invite-token-pepper:v1');
  });

  it('derives the same pepper from the same root secret every time', () => {
    assert.equal(deriveInviteTokenPepper(ROOT_SECRET), deriveInviteTokenPepper(ROOT_SECRET));
    assert.notEqual(deriveInviteTokenPepper(ROOT_SECRET), deriveInviteTokenPepper(`${ROOT_SECRET}x`));
  });

  it('matches a presented token against its stored hash, and nothing else', () => {
    const pepper = deriveInviteTokenPepper(ROOT_SECRET);
    const token = generateInviteToken();
    const stored = computeInviteTokenHash({ token, pepper });

    assert.ok(
      inviteTokenHashMatches({ candidate: computeInviteTokenHash({ token, pepper }), stored }),
    );
    assert.ok(
      !inviteTokenHashMatches({
        candidate: computeInviteTokenHash({ token: generateInviteToken(), pepper }),
        stored,
      }),
    );
    // A token hashed under a DIFFERENT pepper must not match, which is what
    // makes a dumped table uncheckable without the environment.
    assert.ok(
      !inviteTokenHashMatches({
        candidate: computeInviteTokenHash({ token, pepper: deriveInviteTokenPepper('other') }),
        stored,
      }),
    );
    assert.ok(!inviteTokenHashMatches({ candidate: 'short', stored }));
  });
});
