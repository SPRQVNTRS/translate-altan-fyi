/**
 * The voter gate's two behavioural contracts.
 *
 * WHAT THIS FILE HOLDS IN PLACE
 *   The gate reads a cookie and answers with an account id or `null`. It has no
 *   derivation left to test: `enrichment_votes.accountId` is now an `integer`
 *   with a foreign key to `accounts`, so the id is the account's own and the
 *   UUIDv5 bridge that used to live here is deleted. What remains is the pair
 *   of promises its header makes, and both are the kind that only a test keeps:
 *
 *   1. IT NEVER THROWS. The gate is called from an API action that must return
 *      JSON. A cookie that fails to unseal, which is what a rotated
 *      `SESSION_SECRET` or a truncated cookie produces, must read as "signed
 *      out" and not as a 500 on a vote.
 *   2. IT NEVER REDIRECTS. Same reason: a redirect thrown from here would
 *      decide the refusal shape for every caller, including a page that would
 *      rather just hide the buttons.
 *
 *   The signed-in path is not asserted here. Minting a real signed cookie is
 *   what the integration tier does, driving the actual route; a unit test that
 *   faked one would assert the fake.
 *
 * NO DATABASE. `account-gate.server.ts` imports the session storage and the
 * logger, neither of which opens a connection, so the module is imported
 * directly.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { requireVoterAccount } from '../../app/lib/votes/account-gate.server';

/** A request carrying whatever cookie header a case wants to hand the gate. */
function requestWithCookie(cookie: string | null): Request {
  const headers = new Headers();
  if (cookie !== null) headers.set('cookie', cookie);
  return new Request('https://example.test/api/votes', { method: 'POST', headers });
}

describe('votes: the voter gate', () => {
  it('answers null when the request carries no cookie at all', async () => {
    assert.equal(await requireVoterAccount(requestWithCookie(null)), null);
  });

  it('answers null for a cookie that is not this app’s session', async () => {
    assert.equal(await requireVoterAccount(requestWithCookie('some_other_cookie=irrelevant')), null);
  });

  it('answers null rather than throwing when the session cookie cannot be unsealed', async () => {
    // What a rotated SESSION_SECRET looks like from here: a cookie with the
    // right name whose signature no longer verifies. The gate must degrade to
    // "signed out"; a throw would surface as a 500 on a vote.
    const tampered = '_session=eyJhY2NvdW50Ijp7ImlkIjo5OTl9fQ==.not-a-valid-signature';
    assert.equal(await requireVoterAccount(requestWithCookie(tampered)), null);
  });

  it('never redirects, so the caller decides the refusal shape', async () => {
    // A thrown `Response` is how React Router expresses a redirect. Catching it
    // here rather than letting it escape is the whole point: this module must
    // not choose 302 on behalf of an API action that owes JSON.
    for (const cookie of [null, '_session=garbage', 'unrelated=1']) {
      const outcome = await requireVoterAccount(requestWithCookie(cookie)).then(
        (value) => ({ ok: true as const, value }),
        (cause: unknown) => ({ ok: false as const, cause }),
      );
      assert.equal(outcome.ok, true, `the gate threw for cookie ${String(cookie)}: ${String(outcome)}`);
    }
  });
});
