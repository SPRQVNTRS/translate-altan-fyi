/**
 * Who is allowed to vote, and what identifier their vote is stored under.
 *
 * THIS FILE IS A BRIDGE, AND IT IS MEANT TO BE REPLACED.
 *   The account model arrives in M172 and its ids are UUIDs. Today's session
 *   carries the stack's `users.id`, which is a `serial` integer. Rather than
 *   store an integer now and run a data migration later, `enrichment_votes`
 *   already has a `uuid` column and this module derives a stable UUID from the
 *   integer. When real accounts land, the BODY of `requireVoterAccount` becomes
 *   a real account lookup and the column does not move. Migrating a schema is a
 *   deploy risk; changing one function body is a code change.
 *
 * IT NEVER THROWS AND IT NEVER REDIRECTS.
 *   A refusal has a different shape in every caller: the vote route answers 401
 *   with a message key, and a future page may simply hide the buttons. Throwing
 *   a redirect from here would decide that for all of them, and would turn a
 *   read of a cookie into a control-flow jump inside an API action that must
 *   return JSON.
 */

import { createHash } from 'node:crypto';

import { createComponentLogger } from '#app/lib/logger';
import { sessionStorage } from '#app/services/session.server';

const log = createComponentLogger('VoterAccountGate');

/**
 * ARBITRARY, AND FROZEN FOREVER.
 *
 * Any UUID would have done on the day this was written. Once one vote exists,
 * changing it changes every derived account id, so every vote ever cast becomes
 * a vote by a person who no longer exists: the tallies stay, the "my vote"
 * highlight on the entry page disappears for everybody, and a reader who votes
 * again adds a SECOND row instead of replacing their first. Do not regenerate
 * it, do not "tidy" it, and do not derive it from anything.
 */
const VOTER_NAMESPACE_UUID = 'a3f1c0de-4b27-4f8e-9c1a-6d2e8b5f0a71';

/** Where the version nibble lives in the 16 raw bytes, and where the variant bits live. */
const VERSION_BYTE_INDEX = 6;
const VARIANT_BYTE_INDEX = 8;
const UUID_BYTE_LENGTH = 16;

/**
 * The voter's account id, or `null` when nobody is signed in.
 *
 * @param request The incoming request, read only for its cookie header.
 * @returns the account id to store on the vote row, or `null`.
 */
export async function requireVoterAccount(request: Request): Promise<string | null> {
  try {
    const session = await sessionStorage.getSession(request.headers.get('cookie'));
    const user = session.get('user');
    if (!user) return null;
    return accountIdForUserId(user.id);
  } catch (cause) {
    // A cookie that fails to unseal is an unsigned-in visitor, not an outage.
    // The usual causes are a rotated `SESSION_SECRET` and a truncated cookie,
    // and both should show a signed-out page rather than a 500 on a vote.
    log.warn('Could not read the session while resolving a voter', {
      reason: cause instanceof Error ? cause.message : String(cause),
    });
    return null;
  }
}

/**
 * The deterministic UUID one `users.id` maps to.
 *
 * This is RFC 4122 version 5: SHA-1 over the namespace bytes followed by the
 * name bytes, truncated to 16 bytes, with the version and variant bits
 * overwritten. Version 5 rather than a bare hash because the result has to sit
 * in a `uuid` column and read as a well-formed UUID to anything that inspects
 * the table. Same user in, same UUID out, forever, and two different user ids
 * cannot collide short of a SHA-1 collision.
 *
 * @param userId The session's `users.id`.
 * @returns the canonical 8-4-4-4-12 hyphenated form.
 */
export function accountIdForUserId(userId: number): string {
  const namespaceBytes = Buffer.from(VOTER_NAMESPACE_UUID.replaceAll('-', ''), 'hex');
  const nameBytes = Buffer.from(String(userId), 'utf8');

  // SHA-1 produces 20 bytes; a UUID is 16. The specification says to take the
  // FIRST 16 and discard the rest, so the trailing four bytes are dropped here
  // rather than folded in.
  const bytes = createHash('sha1').update(namespaceBytes).update(nameBytes).digest().subarray(0, UUID_BYTE_LENGTH);

  // Version 5 lives in the HIGH nibble of byte 6. `& 0x0f` clears that nibble
  // and keeps the low one, then `| 0x50` writes the literal 5 into it. Anything
  // that reads this value can then tell it was derived rather than randomly
  // generated, which is the difference between a v4 and a v5 UUID.
  const versionByte = bytes[VERSION_BYTE_INDEX] ?? 0;
  bytes[VERSION_BYTE_INDEX] = (versionByte & 0x0f) | 0x50;

  // The RFC 4122 variant lives in the TWO high bits of byte 8, and must read
  // `10`. `& 0x3f` clears both of them and keeps the remaining six, then
  // `| 0x80` sets the pair to `10`. Skipping this step yields a string that
  // still looks like a UUID but declares a legacy variant, and some parsers
  // reject it.
  const variantByte = bytes[VARIANT_BYTE_INDEX] ?? 0;
  bytes[VARIANT_BYTE_INDEX] = (variantByte & 0x3f) | 0x80;

  const hex = bytes.toString('hex');
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20, 32)].join('-');
}
