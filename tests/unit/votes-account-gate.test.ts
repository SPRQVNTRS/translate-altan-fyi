/**
 * The derived voter account id: stable for one reader, distinct between readers,
 * and a well-formed RFC 4122 version 5 UUID.
 *
 * WHAT THIS FILE HOLDS IN PLACE
 *   `enrichment_votes` has a composite primary key on (enrichmentId, accountId),
 *   and that key is the entire "one vote per reader" rule. The account id is
 *   DERIVED from the session's `users.id` rather than stored, so two properties
 *   of the derivation carry the rule:
 *
 *   1. IT MUST BE STABLE. A derivation that moved between calls would give one
 *      reader a fresh account on every vote, so the upsert would never conflict,
 *      every re-vote would add a row, and a single reader could push a tally as
 *      far as they liked by clicking again. That is exactly the abuse the
 *      primary key exists to stop, and no other test would notice.
 *   2. IT MUST BE DISTINCT PER READER. A derivation that collapsed to a constant
 *      would make every reader in the installation share one account, so the
 *      second person to vote on an enrichment would overwrite the first and the
 *      tally could never exceed one. A stability test alone passes happily on a
 *      constant, so both are asserted here.
 *
 *   The UUID shape is the third property, and it is checked at the BIT level
 *   rather than with a loose pattern. The value lands in a Postgres `uuid`
 *   column and is read by tooling that inspects it, so the version nibble and
 *   the variant bits have to be the ones version 5 declares. A hex string of the
 *   right length with the wrong version byte still looks like a UUID in a log
 *   line and still passes a shape regex written from memory.
 *
 * NO DATABASE. `account-gate.server.ts` imports the session storage and the
 * logger, neither of which opens a connection, so the module is imported
 * directly. `requireVoterAccount` is not exercised here: it reads a cookie, and
 * the integration tier drives it through the real route with a real signed
 * cookie.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { accountIdForUserId } from '../../app/lib/votes/account-gate.server';

/** The canonical 8-4-4-4-12 hyphenated form, lowercase hex. Shape only; the bits are checked separately. */
const HYPHENATED_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The 16 raw bytes behind a hyphenated UUID. */
function uuidBytes(value: string): Buffer {
  return Buffer.from(value.replaceAll('-', ''), 'hex');
}

describe('votes: derived account id', () => {
  it('is the same value every time for one user id', () => {
    const first = accountIdForUserId(4711);
    const second = accountIdForUserId(4711);

    assert.equal(
      first,
      second,
      'the derivation is not stable, so one reader gets a new account per vote and the ' +
        '(enrichmentId, accountId) primary key can never make a re-vote replace a vote',
    );
  });

  it('gives two different user ids two different account ids', () => {
    const ids = [1, 2, 3, 41, 4711, 999_999];
    const derived = ids.map((id) => accountIdForUserId(id));
    const distinct = new Set(derived);

    assert.equal(
      distinct.size,
      ids.length,
      `${ids.length} user ids produced ${distinct.size} account id(s): ${derived.join(', ')}. ` +
        'A derivation that does not depend on the user id makes every reader one account, so the second ' +
        'person to vote overwrites the first.',
    );
  });

  it('changes when the user id changes by one', () => {
    // The narrowest possible difference. A derivation that hashed something
    // else, or truncated the input, could still pass the case above on widely
    // spaced ids while collapsing neighbours together.
    assert.notEqual(accountIdForUserId(1000), accountIdForUserId(1001));
  });

  it('is a well-formed version 5 UUID, checked at the bit level', () => {
    const value = accountIdForUserId(4711);

    assert.match(value, HYPHENATED_UUID, `${value} is not the canonical hyphenated UUID form`);

    const bytes = uuidBytes(value);
    assert.equal(bytes.length, 16);

    // The version lives in the HIGH nibble of byte 6 and must read 5. A shape
    // regex cannot see this, and neither can Postgres, which accepts any 16
    // bytes in a `uuid` column.
    const versionNibble = (bytes[6] ?? 0) >> 4;
    assert.equal(
      versionNibble,
      5,
      `the version nibble is ${versionNibble}, not 5, so the value declares a UUID kind it was not derived as`,
    );

    // The RFC 4122 variant lives in the TWO high bits of byte 8 and must read
    // binary 10. Skipping that step yields a string that still looks like a
    // UUID and that some parsers reject.
    const variantBits = (bytes[8] ?? 0) & 0b1100_0000;
    assert.equal(variantBits, 0b1000_0000, `the variant bits are ${variantBits.toString(2)}, not 10xxxxxx`);
  });

  it('keeps the version and variant bits for every user id, not just one', () => {
    // The bits are overwritten on bytes of a digest, so a single sampled id can
    // pass by luck when the masking is wrong: the untouched byte already
    // happened to carry the right nibble.
    for (const id of [0, 1, 7, 64, 255, 4096, 123_456]) {
      const bytes = uuidBytes(accountIdForUserId(id));
      assert.equal((bytes[6] ?? 0) >> 4, 5, `user id ${id} produced a UUID whose version nibble is not 5`);
      assert.equal((bytes[8] ?? 0) & 0b1100_0000, 0b1000_0000, `user id ${id} produced a UUID with the wrong variant`);
    }
  });
});
