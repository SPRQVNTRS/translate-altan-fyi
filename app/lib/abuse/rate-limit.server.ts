/**
 * The trigger rate limit: fixed hourly windows over `abuse_counters`.
 *
 * THE COUNTER ROW IS ANONYMOUS. NO HEADWORD, NO SENSE, NO ACCOUNT ID, NO USER
 * ID, NO RAW ADDRESS, IN ANY ROW THIS MODULE WRITES, EVER.
 *   That is the governing rule of `drizzle/schema/abuse.ts` and it is the whole
 *   reason this file looks the way it does. The cheapest possible spend guard
 *   would write down who asked for what and count it, and that is a search log
 *   wearing a different hat: it would undo the one promise the product makes,
 *   that looking a word up does not build a record of the person looking it up.
 *   What survives the rule is a peppered HASH and a COUNT, which is all "has
 *   this bucket already had its share" ever needed.
 *
 * A FIXED WINDOW, NOT A SLIDING ONE.
 *   `windowStart` floors the clock to the hour in UTC, so every request in one
 *   hour increments exactly one row whose key the caller can compute without
 *   reading the table. A sliding window would need the timestamps of individual
 *   requests, which is per-request evidence of one person's activity, and this
 *   file must not hold that. The other half of the trade is that an expired row
 *   is dead weight a sweep can delete, never a wrong answer, because a check
 *   only ever asks for the CURRENT window's key. The arithmetic is also
 *   testable with no clock mocking: `windowStart` is a pure function of a date.
 *
 * THE INCREMENT IS ONE STATEMENT, AND IT HAS TO BE.
 *   Read-then-write has a window in which two parallel requests both see the old
 *   value and both write the same new one, so a limit of 30 lets 31 through for
 *   every pair that races. `insert ... on conflict do update set count = count +
 *   1 returning count` is evaluated by the database, so the returned figure
 *   already includes this request and no two callers can share it.
 */

import { createHash } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';

import { createComponentLogger } from '#app/lib/logger';
import { abuseCounters, abuseRejections } from '#drizzle/schema';
import { getRawDb } from '#drizzle/tenant-db';

const log = createComponentLogger('AbuseRateLimit');

/**
 * How many enrichment triggers one address may start per hour.
 *
 * The coarser of the two guards. An address is shared by a household, an office
 * or a mobile carrier's NAT pool, so the ceiling is set above what a person
 * reading a dictionary reaches and below what a script walking it needs.
 */
export const TRIGGER_LIMIT_PER_IP_PER_HOUR = 30;

/**
 * How many enrichment triggers one session may start per hour.
 *
 * Lower than the address limit on purpose: a session is one browser, so the
 * honest ceiling for a single reader is tighter than the ceiling for everyone
 * sharing an address behind one router.
 */
export const TRIGGER_LIMIT_PER_SESSION_PER_HOUR = 20;

/** One hour, in milliseconds. The window `windowStart` floors to. */
export const TRIGGER_WINDOW_MS = 3_600_000;

/**
 * How many hex characters of the digest a key keeps.
 *
 * 32 hex characters is 128 bits, which is far past the point where two visitors
 * collide into one bucket. The truncation exists so the key column stays short
 * enough to index cheaply, not to save space in a row.
 */
const KEY_HASH_LENGTH = 32;

/** The session cookie this app sets, from `app/services/session.server.ts`. */
const SESSION_COOKIE_NAME = '_session';

/**
 * The pepper, and the reason the fallback chain is safe.
 *
 * The pepper has exactly two jobs: be secret, and be stable. It is what stops a
 * dump of `abuse_counters` from being a reversible list of visitors, because an
 * attacker holding the table can hash a guessed address only if they also hold
 * the pepper, which lives outside the database.
 *
 * `SESSION_SECRET` is already both of those things in every deployed
 * environment, and it is already required for the app to serve a single logged
 * in page. Falling back to it means this guard works in production with NO new
 * Bay vault key, which is the difference between a guard that ships and a guard
 * that waits for an infrastructure change. `ABUSE_HASH_PEPPER` exists so the two
 * can be rotated apart later without touching this code.
 *
 * The last fallback is a fixed development string, so a local checkout with no
 * environment at all still runs. It is not a secret and is not meant to be: a
 * development database holds no visitors to protect.
 */
const DEVELOPMENT_PEPPER = 'translate-altan-fyi-development-pepper';

function readPepper(): string {
  const configured = process.env.ABUSE_HASH_PEPPER ?? process.env.SESSION_SECRET ?? '';
  if (configured.length > 0) return configured;
  return DEVELOPMENT_PEPPER;
}

/**
 * The floor of `at`'s hour, in UTC.
 *
 * UTC and not a local zone, so the window does not move when the server's zone
 * does and two processes in different zones agree on the same row.
 *
 * @param at any instant inside the window.
 * @returns the instant the window began.
 */
export function windowStart(at: Date): Date {
  return new Date(Math.floor(at.getTime() / TRIGGER_WINDOW_MS) * TRIGGER_WINDOW_MS);
}

/**
 * The address this request came from, or `null` when the header is absent.
 *
 * TRUST DEPTH 1, AND THE NUMBER IS NOT A GUESS.
 *   This deployment's chain is Traefik straight to the Node process. There is no
 *   nginx in this image: see `bay-sprqvntrs/group_vars/all/services.yml`, the
 *   `translate` service, whose `healthcheck_path` comment records the same
 *   shape, and `TRUST_PROXY=1` is already set on stage for exactly this reason.
 *   One hop means ONE entry of `X-Forwarded-For` was appended by a proxy we
 *   run.
 *
 *   At depth 1 the address to take is therefore the LAST entry, because that is
 *   the one Traefik itself observed. Every earlier entry is whatever the caller
 *   chose to put in the header before the request reached us, so taking the
 *   FIRST entry, which is the usual reflex, would let anyone mint a fresh bucket
 *   per request by inventing an address and defeat this whole file with one
 *   line of curl.
 *
 *   Memory `project_bot_verify_rollout` records the mistake this comment exists
 *   to prevent: a proxy count copied from another site, where the chain was
 *   different, produced a verdict that was wrong on every request. The number
 *   above is derived from THIS service's chain and must be re-derived, not
 *   copied, if an nginx or a CDN is ever put in front.
 *
 * @param request the incoming request.
 * @returns the client address as the last proxy observed it, or `null`.
 */
export function clientIp(request: Request): string | null {
  const header = request.headers.get('x-forwarded-for');
  if (header === null) return null;

  const entries = header
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

  return entries[entries.length - 1] ?? null;
}

/**
 * The `_session` cookie's VALUE, or `null` when the request carries none.
 *
 * The value rather than a derived id: it is already opaque, so it needs no
 * further processing to be useless to a reader of this table, and it is stable
 * for as long as the browser holds it, which is what a per-session bucket needs.
 */
function sessionValue(request: Request): string | null {
  const header = request.headers.get('cookie');
  if (header === null) return null;

  for (const part of header.split(';')) {
    const entry = part.trim();
    if (!entry.startsWith(`${SESSION_COOKIE_NAME}=`)) continue;
    const value = entry.slice(SESSION_COOKIE_NAME.length + 1);
    return value.length > 0 ? value : null;
  }
  return null;
}

/**
 * The row key for one bucket.
 *
 * `sha256(pepper + ':' + scope + ':' + value)`, hex, truncated, behind a scope
 * prefix. The scope is inside the hash as well as in front of it: in front so
 * the two kinds of bucket cannot collide in the table, and inside so the same
 * string used as both an address and a session id does not produce the same
 * digest.
 *
 * The session key is hashed for the same reason the address is. A session cookie
 * value written down in a counter table is a credential in a place nobody
 * guards, so a leaked table would otherwise be replayable as a session.
 *
 * @param scope which kind of bucket this is.
 * @param value the raw address or the raw cookie value. It is hashed here and
 *   never stored, never logged and never returned anywhere else.
 * @returns `ip:<hash>` or `session:<hash>`.
 */
export function counterKey(scope: 'ip' | 'session', value: string): string {
  const digest = createHash('sha256').update(`${readPepper()}:${scope}:${value}`).digest('hex');
  return `${scope}:${digest.slice(0, KEY_HASH_LENGTH)}`;
}

/** Whether a trigger may proceed, and which guard turned it away when it may not. */
export type RateLimitVerdict = { allowed: true } | { allowed: false; scope: 'ip' | 'session' };

/**
 * Increment one bucket and return its new count.
 *
 * One statement, evaluated by the database. See the file comment for why a read
 * followed by a write is not good enough here.
 */
async function bumpCounter(key: string, at: Date): Promise<number> {
  const db = getRawDb();
  const rows = await db
    .insert(abuseCounters)
    .values({ key, windowStart: windowStart(at), count: 1 })
    .onConflictDoUpdate({
      target: [abuseCounters.key, abuseCounters.windowStart],
      set: { count: sql`${abuseCounters.count} + 1` },
    })
    .returning({ count: abuseCounters.count });

  return rows[0]?.count ?? 1;
}

/**
 * Count this trigger against both buckets and say whether it may proceed.
 *
 * BOTH COUNTERS ARE INCREMENTED, ALWAYS, EVEN WHEN THE FIRST ONE IS ALREADY
 * OVER. Skipping the second increment would make its window depend on the
 * first's, so a visitor over the address limit would quietly bank session
 * allowance for the next hour.
 *
 * A MISSING ADDRESS IS NOT A REJECTION. In local development, and behind any
 * proxy that has not been configured to append the header, `X-Forwarded-For` is
 * absent. Treating that as "over the limit" would lock the app for the developer
 * who has no proxy at all, so the address guard simply does not apply and the
 * session guard carries the request on its own.
 *
 * @param request the incoming request, read for its address and session cookie.
 * @param at the instant to count under. A parameter so the window arithmetic is
 *   testable without mocking the clock.
 * @returns allowed, or refused with the guard that refused it.
 */
export async function checkTriggerRateLimit(request: Request, at: Date = new Date()): Promise<RateLimitVerdict> {
  const ip = clientIp(request);
  const session = sessionValue(request);

  const ipCount = ip === null ? 0 : await bumpCounter(counterKey('ip', ip), at);
  const sessionCount = session === null ? 0 : await bumpCounter(counterKey('session', session), at);

  const ipOver = ipCount > TRIGGER_LIMIT_PER_IP_PER_HOUR;
  const sessionOver = sessionCount > TRIGGER_LIMIT_PER_SESSION_PER_HOUR;
  if (!ipOver && !sessionOver) return { allowed: true };

  // The address verdict wins when both are over, because the address is the
  // coarser guard: it is the one that describes the traffic rather than the one
  // browser it happened to arrive in, so it is the more useful answer on the
  // admin page and in a log line.
  const scope = ipOver ? 'ip' : 'session';
  await recordRejection('rate-limited', at);
  log.info('Enrichment trigger refused by the rate limit', { scope });
  return { allowed: false, scope };
}

/**
 * Count one refusal, so the admin page can see what was turned away today.
 *
 * A refusal is otherwise invisible, and a cap or a limit set too low then looks
 * exactly like a quiet day. The row carries a day, a reason and a count, and
 * nothing about who was refused.
 *
 * @param reason which guard refused. The two literals match the check constraint
 *   on the table.
 * @param at the instant to count under.
 */
export async function recordRejection(reason: 'rate-limited' | 'budget', at: Date = new Date()): Promise<void> {
  const db = getRawDb();
  await db
    .insert(abuseRejections)
    .values({ day: utcDayKey(at), reason, count: 1 })
    .onConflictDoUpdate({
      target: [abuseRejections.day, abuseRejections.reason],
      set: { count: sql`${abuseRejections.count} + 1` },
    });
}

/** Today's refusals, per reason. */
export interface RejectionCounts {
  rateLimited: number;
  budget: number;
}

/**
 * The counts the admin page reads.
 *
 * An absent row is a zero rather than a missing key, so the page renders "0"
 * instead of a blank, and a quiet day and a broken counter do not look alike.
 *
 * @param at the instant whose UTC day to read.
 */
export async function readRejections(at: Date = new Date()): Promise<RejectionCounts> {
  const db = getRawDb();
  const rows = await db
    .select({ reason: abuseRejections.reason, count: abuseRejections.count })
    .from(abuseRejections)
    .where(eq(abuseRejections.day, utcDayKey(at)));

  const counts: RejectionCounts = { rateLimited: 0, budget: 0 };
  for (const row of rows) {
    if (row.reason === 'rate-limited') counts.rateLimited = row.count;
    if (row.reason === 'budget') counts.budget = row.count;
  }
  return counts;
}

/**
 * Today's count for one bucket key, without incrementing it.
 *
 * The read the operator page uses to prove a derivation on the real deployment.
 * It must never be used to decide a request: only the atomic increment in
 * `bumpCounter` can do that.
 *
 * @param key a key from `counterKey`.
 * @param at the instant whose window to read.
 */
export async function readCounter(key: string, at: Date = new Date()): Promise<number> {
  const db = getRawDb();
  const rows = await db
    .select({ count: abuseCounters.count })
    .from(abuseCounters)
    .where(and(eq(abuseCounters.key, key), eq(abuseCounters.windowStart, windowStart(at))));

  return rows[0]?.count ?? 0;
}

/**
 * The UTC day key, `YYYY-MM-DD`.
 *
 * Duplicated deliberately rather than imported from the budget module: importing
 * it would make the rate limiter depend on the spend cap, and the two guards are
 * meant to be able to fail independently.
 */
function utcDayKey(at: Date): string {
  return at.toISOString().slice(0, 10);
}
