/**
 * THE SIGNED-IN DEVICES OF ONE ACCOUNT, AND THE REVOKE THAT ENDS ONE OF THEM.
 *
 * THERE IS NO `devices` TABLE, AND ADDING ONE WOULD BE A MISTAKE. A device
 * here IS a token family. PROTOCOL.md section 4.2 already carries the whole
 * concept: every access/refresh pair carries a `family_id` that survives
 * rotation, `POST /v1/auth/logout` revokes exactly one family and leaves the
 * account's other sessions alone, and reuse detection revokes a family. One
 * family is one device's session, from the moment it signed in until the
 * moment it signed out. So `account_tokens.family_id` is the feature, and this
 * module is a projection over it: no migration, no new column, no new table,
 * and nothing to keep in step with the token lifecycle because it IS the token
 * lifecycle.
 *
 * A registry would have to be written on signup, updated on refresh, deleted
 * on logout and swept on expiry, and every one of those is a chance for it to
 * disagree with the tokens that actually authenticate. The disagreement would
 * show up as a device the user cannot sign out, or a signed-out device the
 * screen still lists. Deriving the list removes the class.
 *
 * WHAT THIS MODULE DOES NOT KNOW. It never sees a raw token except the one the
 * caller already holds in its own cookie, it never returns a token or a digest,
 * and it holds no key for anything. The account's data stays sealed; this is a
 * view of sessions, not of content.
 *
 * `accounts` and `account_tokens` are GLOBAL tables. Neither carries an
 * `organizationId` and neither is in `TENANT_TABLES`, so `getRawDb()` is the
 * sanctioned reach rather than a bypass of `tenantDb(ctx)` (ADR-0003), exactly
 * as in `app/services/e2ee-blob-usage.server.ts`.
 *
 * `.server.ts` because it touches the connection pool and the session cookie.
 */
import { and, desc, eq, gt, isNotNull, isNull, max, min } from 'drizzle-orm';

import { accountTokens } from '#drizzle/schema';
import { getRawDb } from '#drizzle/tenant-db';
import { hashToken } from '#app/lib/e2ee/tokens';
import { createComponentLogger } from '#app/lib/logger';
import { sessionStorage } from '#app/services/session.server';

const log = createComponentLogger('AccountDevices');

/** One signed-in device, derived entirely from its token family. */
export interface AccountDevice {
  familyId: string;
  /** When the family was first minted, which is when that device signed in. */
  createdAt: Date;
  /**
   * The most recent token in the family. Every refresh rotation mints a new
   * row, so this is the last time that device proved it was still there. It is
   * an approximation and it is the honest one available: nothing writes a
   * heartbeat, and adding one would be a new write on every request to report a
   * timestamp nobody acts on.
   */
  lastSeenAt: Date;
}

/**
 * A device as it crosses to the browser: instants as ISO-8601 UTC strings
 * (PROTOCOL.md section 4), plus the one derived flag the UI needs.
 */
export interface AccountDeviceSummary {
  familyId: string;
  createdAt: string;
  lastSeenAt: string;
  /** Whether this is the family of the caller's own access token. Decided on the server, never in the client. */
  current: boolean;
}

/**
 * The account's live sessions, newest first. Revoked and expired families are
 * excluded: they are not devices any more.
 *
 * A family is LIVE when at least one of its rows is unrevoked and still within
 * its expiry. `createdAt` is the earliest row in the family and `lastSeenAt`
 * the latest, so a device that has rotated its refresh token ten times still
 * reports the one sign-in it actually performed.
 *
 * Rows with a `NULL` family_id are skipped. The column is nullable because it
 * outlived the two single-use link kinds, which had no lineage; every row
 * written today carries one, and a row that carries none cannot be revoked as
 * a device because there is nothing to name.
 *
 * @param accountId the account whose sessions to list.
 * @param now the instant expiry is judged against. Injectable so the rule is testable without waiting.
 * @returns one entry per live family, most recently active first.
 */
export async function listAccountDevices(accountId: number, now?: Date): Promise<AccountDevice[]> {
  const at = now ?? new Date();
  const firstSeen = min(accountTokens.createdAt);
  const lastSeen = max(accountTokens.createdAt);

  const rows = await getRawDb()
    .select({ familyId: accountTokens.familyId, createdAt: firstSeen, lastSeenAt: lastSeen })
    .from(accountTokens)
    .where(
      and(
        eq(accountTokens.accountId, accountId),
        isNotNull(accountTokens.familyId),
        isNull(accountTokens.revokedAt),
        gt(accountTokens.expiresAt, at),
      ),
    )
    .groupBy(accountTokens.familyId)
    .orderBy(desc(lastSeen));

  const devices: AccountDevice[] = [];
  for (const row of rows) {
    // Three null checks the aggregate cannot express away: `family_id` is a
    // nullable column even though the WHERE excludes nulls, and an aggregate
    // over a group is typed as nullable even though a group always has a row.
    if (row.familyId === null || row.createdAt === null || row.lastSeenAt === null) continue;
    devices.push({ familyId: row.familyId, createdAt: row.createdAt, lastSeenAt: row.lastSeenAt });
  }
  return devices;
}

export interface RevokeAccountDeviceInput {
  accountId: number;
  familyId: string;
  revokedAt?: Date;
}

/**
 * Ends one device's session.
 *
 * THE ACCOUNT FILTER AND THE FAMILY FILTER ARE IN THE SAME STATEMENT, and that
 * is the security property of this function. Reading the family first and then
 * writing on the strength of what came back is a check-then-act, and the check
 * is the only thing standing between one account and another account's
 * session. There is no interleaving that can separate the two halves here,
 * because there are no two halves.
 *
 * EVERY ROW OF THE FAMILY IS REVOKED, not just the refresh token. An access
 * token minted by an earlier rotation is a working credential for up to
 * fifteen more minutes, and a user who signs a device out means now.
 *
 * ROWS ARE RETAINED, NEVER DELETED. `app/lib/e2ee/tokens.ts` gives the reason:
 * a presented-but-revoked refresh token is the reuse signal, and you cannot
 * detect reuse of a row you deleted. Revocation is also permanent, set once and
 * never cleared, so signing a device back in mints new rows rather than reviving
 * these.
 *
 * @param input the account, the family to end, and the instant to stamp.
 * @returns whether a live family with that id belonged to this account. `false`
 *   for an unknown id AND for another account's id alike, so this cannot be
 *   used to probe which family ids exist.
 */
export async function revokeAccountDevice(input: RevokeAccountDeviceInput): Promise<boolean> {
  const at = input.revokedAt ?? new Date();

  const revoked = await getRawDb()
    .update(accountTokens)
    .set({ revokedAt: at })
    .where(
      and(
        eq(accountTokens.accountId, input.accountId),
        eq(accountTokens.familyId, input.familyId),
        isNull(accountTokens.revokedAt),
      ),
    )
    .returning({ expiresAt: accountTokens.expiresAt });

  // "Live" is the same test `listAccountDevices` applies, so the answer agrees
  // with the list the caller was looking at. Already-expired rows are revoked
  // anyway (it costs one UPDATE and closes any clock skew), but they do not
  // make the family a device.
  return revoked.some((row) => row.expiresAt.getTime() > at.getTime());
}

export interface ListAccountDevicesForRequestInput {
  /** Read for its session cookie, to learn which family this browser is holding. */
  request: Request;
  /** The already-resolved caller. Never taken from the request body: a caller does not name whose devices it reads. */
  accountId: number;
}

/**
 * The device list as a screen and the API both want it: serialized, and with
 * the caller's own device marked.
 *
 * ONE FUNCTION FOR BOTH CALLERS, deliberately. `/account`'s loader and
 * `GET /api/v1/auth/devices` must agree about what "this device" means, and
 * the cheapest way to guarantee that is for there to be one implementation of
 * it rather than two that look alike.
 *
 * `current` IS DECIDED HERE, ON THE SERVER. The alternative, sending the
 * caller's own family id down and comparing in the browser, would put a
 * session identifier into the HTML for no gain: the client cannot do anything
 * with it that this comparison has not already done.
 *
 * A COOKIE THAT DOES NOT UNSEAL IS NOT AN OUTAGE. It yields no current family,
 * so every device renders unmarked and the list is still correct. That is the
 * same contract `app/services/account-session.server.ts` documents.
 *
 * @param input the request and the resolved account id.
 * @returns the live devices, newest first, with ISO-8601 instants.
 */
export async function listAccountDevicesForRequest(
  input: ListAccountDevicesForRequestInput,
): Promise<AccountDeviceSummary[]> {
  const [devices, currentFamilyId] = await Promise.all([
    listAccountDevices(input.accountId),
    readCurrentFamilyId(input),
  ]);

  return devices.map((device) => ({
    familyId: device.familyId,
    createdAt: device.createdAt.toISOString(),
    lastSeenAt: device.lastSeenAt.toISOString(),
    current: currentFamilyId !== null && device.familyId === currentFamilyId,
  }));
}

/**
 * The family of the access token in the caller's cookie, or `null`.
 *
 * THE NARROWEST LOOKUP THAT ANSWERS "WHICH ONE AM I". It matches on the
 * token's SHA-256 digest, which is the only form the database holds
 * (`app/lib/e2ee/tokens.ts`), and it filters on `account_id` in the same
 * statement so a cookie belonging to another account cannot name a family
 * here. Expiry and revocation are not re-checked: the caller has already been
 * resolved by `getAccountSession`, and a family that is not live simply will
 * not appear in the list this value is compared against.
 */
async function readCurrentFamilyId(input: ListAccountDevicesForRequestInput): Promise<string | null> {
  const accessToken = await readAccessToken(input.request);
  if (accessToken === null) return null;

  const [row] = await getRawDb()
    .select({ familyId: accountTokens.familyId })
    .from(accountTokens)
    .where(
      and(eq(accountTokens.accountId, input.accountId), eq(accountTokens.tokenHash, hashToken(accessToken))),
    )
    .limit(1);
  return row?.familyId ?? null;
}

/** The raw access token in the cookie, or `null`. An unsealable cookie is a signed-out visitor, never a 500. */
async function readAccessToken(request: Request): Promise<string | null> {
  try {
    const session = await sessionStorage.getSession(request.headers.get('cookie'));
    return session.get('account')?.accessToken ?? null;
  } catch (cause) {
    log.warn('Could not read the session cookie', {
      reason: cause instanceof Error ? cause.message : String(cause),
    });
    return null;
  }
}
