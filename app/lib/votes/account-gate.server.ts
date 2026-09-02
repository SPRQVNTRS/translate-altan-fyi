/**
 * Who is allowed to vote, and what identifier their vote is stored under.
 *
 * THE BRIDGE IS GONE. This module used to derive a stable UUIDv5 from the
 * stack's session `users.id`, because `enrichment_votes.accountId` was a
 * `uuid` and there was no account table to point at. Its own header said the
 * replacement would be a real account lookup with the column staying put. That
 * is what happened, except that the column moved too: accounts arrived in M172
 * with `serial` ids, so `accountId` is now an `integer` with a real foreign key
 * and there is nothing left to derive. The frozen namespace UUID and the
 * derivation went with it.
 *
 * IT NEVER THROWS AND IT NEVER REDIRECTS.
 *   A refusal has a different shape in every caller: the vote route answers 401
 *   with a message key, and a future page may simply hide the buttons. Throwing
 *   a redirect from here would decide that for all of them, and would turn a
 *   read of a cookie into a control-flow jump inside an API action that must
 *   return JSON.
 */

import { createComponentLogger } from '#app/lib/logger';
import { sessionStorage } from '#app/services/session.server';

const log = createComponentLogger('VoterAccountGate');

/**
 * The voter's account id, or `null` when nobody is signed in.
 *
 * @param request The incoming request, read only for its cookie header.
 * @returns the account id to store on the vote row, or `null`.
 */
export async function requireVoterAccount(request: Request): Promise<number | null> {
  try {
    const session = await sessionStorage.getSession(request.headers.get('cookie'));
    // The account session, written by the sign-in bridge. A session that still
    // carries only the old `user` key resolves to `null` here: no vote is
    // attributed to a reader whose account this cookie cannot name.
    return session.get('account')?.id ?? null;
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
