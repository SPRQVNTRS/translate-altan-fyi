/**
 * One address bursting past its hourly ceiling is refused, and only that address.
 *
 * WHAT THIS FILE HOLDS IN PLACE
 *   `checkTriggerRateLimit` is the guard that decides whether a visitor may
 *   start a paid enrichment. A red case here is a real defect.
 *
 *   1. THE CEILING MUST ACTUALLY BIND. The increment is written as one
 *      `insert ... on conflict do update ... returning count` statement, because
 *      a read followed by a write lets two parallel requests share a number and
 *      a limit of 30 then admits 31 for every pair that races. Only a real
 *      database can show the count crossing the line, so this belongs in the
 *      integration tier.
 *   2. THE BUCKET MUST BE PER ADDRESS. A second address in the same window is
 *      driven here after the first is over its limit. Without that case, a guard
 *      that refused EVERYBODY once anybody was over would pass: it turns away
 *      the burst, which is all a single-address test can see, while taking the
 *      whole site off the air.
 *   3. A REFUSAL MUST BE VISIBLE. `abuse_rejections` is the only record that a
 *      guard did anything; without it, a ceiling set too low looks exactly like
 *      a quiet day. The count is asserted against the baseline read before the
 *      burst, so the case cannot pass on somebody else's row.
 *
 *   The fourth case is a SOURCE INSPECTION, and it is deliberate. The spec's
 *   rule is that A CACHE HIT IS NOT A TRIGGER: a `ready` panel queues nothing
 *   and costs nothing, so counting it against the limit would make the honest
 *   majority of readers exhaust the allowance while the script walking uncached
 *   words keeps its own. The guard that enforces it is an early return inside
 *   `triggerEnrichment` in `app/routes/entry.$headwordId.tsx`, and that function
 *   is not exported: reaching it honestly would mean driving the whole loader
 *   with a headword, its senses and a cached enrichment already in place, which
 *   is a second fixture the size of `votes-reenrichment.test.ts` for one
 *   ordering fact. The case therefore reads the route as text and pins the
 *   ORDER: the `ready` return sits ABOVE the only call to the limiter. That is
 *   weaker than driving it, and it is recorded as such rather than dressed up.
 *
 * NO PROVIDER IS INVOLVED. The rate limiter counts rows; nothing here reaches a
 * model, and no enqueue happens.
 *
 * THE PRECONDITION IS A REACHABLE DATABASE
 *   `DB_HOST` and the other `DB_*` variables, nothing else. Every case gates on
 *   `DB_HOST` alone, which `tests/unit/integration-tests-self-skip.test.ts`
 *   enforces. The source-inspection case needs no database and is gated anyway,
 *   because that guard counts cases and not preconditions.
 *
 * ISOLATION
 *   Both addresses are drawn at random from the documentation range, and every
 *   call is charged to a window in the next century, so no row this file touches
 *   can be one a real visitor or another suite created. The counter rows are
 *   deleted by their exact keys in `after()` and the rejection row by its day.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { and, eq, inArray } from 'drizzle-orm';

import { pool } from '../../drizzle/db';
import { getRawDb } from '../../drizzle/tenant-db';
import { abuseCounters, abuseRejections } from '../../drizzle/schema';
import {
  checkTriggerRateLimit,
  counterKey,
  readCounter,
  readRejections,
  windowStart,
  TRIGGER_LIMIT_PER_IP_PER_HOUR,
} from '../../app/lib/abuse/rate-limit.server';

const DB_HOST = process.env.DB_HOST;

const db = getRawDb();

/** The route whose ordering the last case reads. */
const ENTRY_ROUTE = fileURLToPath(new URL('../../app/routes/entry.$headwordId.tsx', import.meta.url));

/** An address from the documentation range, with a random host part so no run can share a bucket with another. */
function documentationAddress(): string {
  return `203.0.113.${1 + Math.floor(Math.random() * 250)}`;
}

const BURSTING_ADDRESS = documentationAddress();
const QUIET_ADDRESS = documentationAddress();

/** The instant every call is charged to: midday of a random day in the next century. */
const AT = new Date(
  `${new Date(Date.UTC(2099, 0, 1) + Math.floor(Math.random() * 2000) * 86_400_000).toISOString().slice(0, 10)}T12:00:00.000Z`,
);

/** The day the rejection row lands on, which is derived from `AT` and is therefore also in the future. */
const REJECTION_DAY = AT.toISOString().slice(0, 10);

/** Today's rejection counts before anything in this file ran. */
let baselineRateLimited = 0;

/** A request from one address, carrying no cookie, so only the address bucket is counted. */
function requestFrom(address: string): Request {
  return new Request('https://translate.altan.fyi/entry/whatever', {
    headers: { 'x-forwarded-for': address },
  });
}

/** Block comments and line comments removed, so prose about a rule cannot satisfy a check for the rule. */
function stripComments(source: string): string {
  return source.replaceAll(/\/\*[\s\S]*?\*\//g, ' ').replaceAll(/\/\/[^\n]*/g, ' ');
}

before(async () => {
  if (!DB_HOST) return;

  assert.notEqual(BURSTING_ADDRESS, QUIET_ADDRESS, 'the two addresses collided, so the second case proves nothing');
  const rejections = await readRejections(AT);
  baselineRateLimited = rejections.rateLimited;
});

after(async () => {
  if (!DB_HOST) {
    await pool.end();
    return;
  }

  const keys = [counterKey('ip', BURSTING_ADDRESS), counterKey('ip', QUIET_ADDRESS)];
  await db
    .delete(abuseCounters)
    .where(and(inArray(abuseCounters.key, keys), eq(abuseCounters.windowStart, windowStart(AT))));
  await db.delete(abuseRejections).where(eq(abuseRejections.day, REJECTION_DAY));

  await pool.end();
});

describe('abuse: the trigger rate limit', () => {
  it('lets one address through its allowance and refuses the request past it', { skip: !DB_HOST ? 'DB_HOST not set' : false }, async () => {
    // A fresh future window, so the count starts from nothing and the boundary
    // below is the real one rather than an offset of somebody else's traffic.
    const key = counterKey('ip', BURSTING_ADDRESS);
    assert.equal(await readCounter(key, AT), 0, 'the window was not empty, so the ceiling below is not the real one');

    const verdicts = [];
    for (let attempt = 1; attempt <= TRIGGER_LIMIT_PER_IP_PER_HOUR + 1; attempt += 1) {
      verdicts.push(await checkTriggerRateLimit(requestFrom(BURSTING_ADDRESS), AT));
    }

    const lastAllowed = verdicts[TRIGGER_LIMIT_PER_IP_PER_HOUR - 1];
    const firstRefused = verdicts[TRIGGER_LIMIT_PER_IP_PER_HOUR];

    assert.equal(
      lastAllowed?.allowed,
      true,
      `request ${TRIGGER_LIMIT_PER_IP_PER_HOUR} was refused, so the ceiling bites one request early and a reader ` +
        'never reaches the allowance the constant names',
    );
    assert.equal(
      firstRefused?.allowed,
      false,
      `request ${TRIGGER_LIMIT_PER_IP_PER_HOUR + 1} was allowed, so the ceiling does not bind and one address can ` +
        'start an unbounded number of paid enrichments per hour',
    );
    assert.equal(
      firstRefused?.allowed === false ? firstRefused.scope : null,
      'ip',
      'the refusal was not attributed to the address guard, so the admin page and the log line name the wrong one',
    );

    // The counter reached the number of requests, not fewer: a lost increment
    // is how a limit of 30 quietly becomes a limit of 60.
    assert.equal(await readCounter(key, AT), TRIGGER_LIMIT_PER_IP_PER_HOUR + 1);
  });

  it('leaves a second address in the same window untouched', { skip: !DB_HOST ? 'DB_HOST not set' : false }, async () => {
    // Runs AFTER the burst above, on purpose. The first address is over its
    // ceiling right now, so a guard that refused everybody once anybody was over
    // would be caught here and nowhere else.
    const verdict = await checkTriggerRateLimit(requestFrom(QUIET_ADDRESS), AT);

    assert.equal(
      verdict.allowed,
      true,
      'an address that has made one request was refused while another address was over its limit, so one visitor ' +
        'flooding the site turns the enrichment trigger off for everybody',
    );
    assert.equal(await readCounter(counterKey('ip', QUIET_ADDRESS), AT), 1);
    assert.equal(await readCounter(counterKey('ip', BURSTING_ADDRESS), AT), TRIGGER_LIMIT_PER_IP_PER_HOUR + 1);
  });

  it('records the refusal where the operator can see it', { skip: !DB_HOST ? 'DB_HOST not set' : false }, async () => {
    const rejections = await readRejections(AT);

    assert.equal(
      rejections.rateLimited - baselineRateLimited,
      1,
      `the burst produced ${rejections.rateLimited - baselineRateLimited} recorded rejection(s), expected 1. ` +
        'A refusal that is not counted is invisible: a ceiling set too low then looks exactly like a quiet day.',
    );
    assert.equal(rejections.budget, 0, 'a rate-limit refusal was recorded against the budget reason');
  });

  it('reaches the limiter only past the cache-hit guard, by source inspection', { skip: !DB_HOST ? 'DB_HOST not set' : false }, async () => {
    // SOURCE INSPECTION, NOT BEHAVIOUR. See the file comment for why: the
    // function that holds this ordering is not exported, and driving it would
    // need a whole cached entry as a fixture.
    const code = stripComments(readFileSync(ENTRY_ROUTE, 'utf8'));

    // Vacuity guard. A stripper that ate the file would satisfy every index
    // check below by finding nothing at all.
    assert.ok(code.length > 2000, `only ${code.length} characters of code survived comment stripping`);

    const calls = code.match(/checkTriggerRateLimit\(/g) ?? [];
    assert.equal(
      calls.length,
      1,
      `the entry route calls checkTriggerRateLimit ${calls.length} time(s). Exactly one call site is what makes ` +
        'the ordering below a fact about every trigger rather than about one branch.',
    );

    const readyGuard = code.indexOf("panel.state === 'ready'");
    const limiterCall = code.indexOf('checkTriggerRateLimit(');
    const refusalCall = code.indexOf('refuseTrigger(request)');

    assert.ok(readyGuard > 0, "the entry route no longer returns early for a 'ready' panel, so a cache hit is counted");
    assert.ok(refusalCall > 0, 'the entry route no longer routes its trigger through refuseTrigger');
    assert.ok(
      readyGuard < refusalCall && refusalCall < limiterCall,
      'the cache-hit early return no longer sits above the rate-limit call. A ready panel queues nothing and ' +
        'spends nothing, so counting it makes the readers who cost nothing exhaust the allowance while a script ' +
        'walking uncached words keeps its own.',
    );
  });
});
