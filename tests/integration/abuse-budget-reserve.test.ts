/**
 * Ten parallel reservations against headroom that fits three must grant three.
 *
 * WHAT THIS FILE HOLDS IN PLACE
 *   `app/lib/abuse/budget.server.ts` is the only thing standing between an
 *   unattended script and the bill. A red case here is a real defect, and it is
 *   a defect that costs money.
 *
 *   1. THE GRANT IS ONE STATEMENT, AND ONLY THE DATABASE CAN MAKE THAT TRUE. A
 *      read followed by a write has a window in which N parallel callers all see
 *      the same low total and all pass. The window is small and it is exactly
 *      what a script hits, so the cap has to be exercised UNDER CONCURRENCY or
 *      it is not exercised at all. Ten reservations race for three units of
 *      headroom here, and four grants is as much a failure as ten.
 *   2. THE CONDITION READS `reserved + spent`. `settle` moves a figure out of
 *      `reserved` and into `spent`, so a condition that looked at `reserved`
 *      alone would see the headroom restored after every completed call and the
 *      cap would never bind. The settle case below leaves the day at its total
 *      and the reserve that follows must still be refused.
 *   3. NEITHER COLUMN MAY GO BELOW ZERO. A double release, or a release of a
 *      reservation that was never granted, must degrade to a STRICTER cap and
 *      never to a free one. A negative `reserved` is headroom nobody paid for,
 *      and it persists for the rest of the day.
 *
 * NO PROVIDER IS INVOLVED. Nothing here calls a model: `reserve`, `settle` and
 * `release` are arithmetic over one row. `ALERT_WEBHOOK_URL` is cleared for the
 * duration of the file so a refusal cannot post to a real webhook either.
 *
 * THE PRECONDITION IS A REACHABLE DATABASE
 *   `DB_HOST` and the other `DB_*` variables, nothing else. Every case gates on
 *   `DB_HOST` alone, which `tests/unit/integration-tests-self-skip.test.ts`
 *   enforces.
 *
 * ISOLATION, AND WHY THE DAYS ARE IN THE NEXT CENTURY
 *   `daily_budget` is a shared singleton keyed by day, and this database is also
 *   a developer's dev database. Charging today's row would corrupt a real figure
 *   and would make the assertions depend on whatever else had spent today. Every
 *   case therefore passes its own `at` instant, drawn from a RANDOM day far in
 *   the future, so it owns its row outright. Every row this file creates is
 *   deleted in `after()`, and nothing else is touched.
 *
 *   `alert_log` is the one row this file cannot place in the future: a refusal
 *   raises the `budget-cap` alert under the PROCESS day, not under the charged
 *   day, so the row lands on today. Today's (day, kind) pairs are therefore
 *   photographed before the run and only pairs that appear DURING it are
 *   deleted. A pre-existing operator alert survives untouched.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { and, eq, inArray } from 'drizzle-orm';

import { pool } from '../../drizzle/db';
import { getRawDb } from '../../drizzle/tenant-db';
import { alertLog, dailyBudget } from '../../drizzle/schema';
import {
  isBudgetExhausted,
  readBudget,
  release,
  reserve,
  settle,
  utcDay,
  DAILY_BUDGET_USD,
} from '../../app/lib/abuse/budget.server';

const DB_HOST = process.env.DB_HOST;

const db = getRawDb();

/** How many reservations race for the headroom in the concurrency case. */
const BURST_SIZE = 10;

/** How many of them must be granted. The headroom below is arranged to fit exactly this many. */
const EXPECTED_GRANTS = 3;

/** What each racing reservation asks for. */
const ESTIMATE_USD = 0.1;

/**
 * The first day of this run's block, in the next century.
 *
 * Random rather than fixed so two runs, or a run beside a stale row a previous
 * run failed to clean up, cannot share a row and read each other's figures. It
 * is drawn ONCE and the cases take consecutive days from it, so no two cases can
 * collide with each other however the draw lands.
 */
const DAY_BLOCK_START_MS = Date.UTC(2099, 0, 1) + Math.floor(Math.random() * 2000) * 86_400_000;

/** The day `offset` days into this run's block. */
function futureDay(offset: number): string {
  return new Date(DAY_BLOCK_START_MS + offset * 86_400_000).toISOString().slice(0, 10);
}

/** The instant at midday of a day, which is what every call under test is charged to. */
function middayOf(day: string): Date {
  return new Date(`${day}T12:00:00.000Z`);
}

const DAY_CONCURRENCY = futureDay(0);
const DAY_RELEASE = futureDay(1);
const DAY_SETTLE = futureDay(2);
const DAY_FLOOR = futureDay(3);
const DAY_EXHAUSTED = futureDay(4);

const ALL_DAYS = [DAY_CONCURRENCY, DAY_RELEASE, DAY_SETTLE, DAY_FLOOR, DAY_EXHAUSTED];

/** The alert kinds that already existed for today before this file ran, so they are not deleted afterwards. */
const preExistingAlertKinds = new Set<string>();

/** The webhook URL as the environment had it, restored in `after()`. */
const originalWebhookUrl = process.env.ALERT_WEBHOOK_URL;

/** A money figure as the `numeric(12, 6)` columns take it. */
function money(value: number): string {
  return value.toFixed(6);
}

/** Put a day's row in a known state. The row belongs to this file, so writing it directly is safe. */
async function seedDay(day: string, reservedUsd: number, spentUsd: number): Promise<void> {
  await db
    .insert(dailyBudget)
    .values({ day, reservedUsd: money(reservedUsd), spentUsd: money(spentUsd) })
    .onConflictDoUpdate({
      target: dailyBudget.day,
      set: { reservedUsd: money(reservedUsd), spentUsd: money(spentUsd) },
    });
}

before(async () => {
  if (!DB_HOST) return;

  // A refusal sends an operator alert. There must be nowhere for it to go.
  delete process.env.ALERT_WEBHOOK_URL;

  const today = utcDay(new Date());
  const rows = await db.select({ kind: alertLog.kind }).from(alertLog).where(eq(alertLog.day, today));
  for (const row of rows) preExistingAlertKinds.add(row.kind);
});

after(async () => {
  if (!DB_HOST) {
    await pool.end();
    return;
  }

  await db.delete(dailyBudget).where(inArray(dailyBudget.day, ALL_DAYS));

  // Only the alert rows that appeared while this file ran. A pre-existing row
  // belongs to the operator and is left alone.
  const today = utcDay(new Date());
  const rows = await db.select({ kind: alertLog.kind }).from(alertLog).where(eq(alertLog.day, today));
  const mine = rows.map((row) => row.kind).filter((kind) => !preExistingAlertKinds.has(kind));
  if (mine.length > 0) {
    await db.delete(alertLog).where(and(eq(alertLog.day, today), inArray(alertLog.kind, mine)));
  }

  if (originalWebhookUrl !== undefined) process.env.ALERT_WEBHOOK_URL = originalWebhookUrl;

  await pool.end();
});

describe('abuse: the daily budget cap', () => {
  it('grants exactly the reservations that fit, out of a parallel burst', { skip: !DB_HOST ? 'DB_HOST not set' : false }, async () => {
    // Headroom of exactly three estimates: cap 3.00, already committed 2.70,
    // each reservation 0.10. The fourth would take the day to 3.10.
    const headroom = EXPECTED_GRANTS * ESTIMATE_USD;
    await seedDay(DAY_CONCURRENCY, DAILY_BUDGET_USD - headroom, 0);

    const at = middayOf(DAY_CONCURRENCY);
    const outcomes = await Promise.all(Array.from({ length: BURST_SIZE }, () => reserve(ESTIMATE_USD, at)));
    const granted = outcomes.filter((outcome) => outcome.ok);

    assert.equal(
      granted.length,
      EXPECTED_GRANTS,
      `${BURST_SIZE} parallel reservations against headroom for ${EXPECTED_GRANTS} granted ${granted.length}. ` +
        'Each extra grant is a provider call the cap was configured to refuse. The grant must be ONE statement ' +
        'evaluated by the database: a read followed by a write lets every caller in the window see the same low ' +
        'total and pass.',
    );

    // The stored figure, not the return values. The return values are what this
    // process believes happened; the row is what the cap will actually enforce
    // for the rest of the day.
    const snapshot = await readBudget(at);
    assert.equal(snapshot.reservedUsd, DAILY_BUDGET_USD, `reserved_usd is ${snapshot.reservedUsd}, expected the cap`);
    assert.equal(snapshot.spentUsd, 0);

    // And the day is now closed: an eleventh reservation is refused.
    const afterwards = await reserve(ESTIMATE_USD, at);
    assert.equal(afterwards.ok, false, 'a reservation was granted past the cap');
  });

  it('gives a released unit back, and the next reservation then fits', { skip: !DB_HOST ? 'DB_HOST not set' : false }, async () => {
    await seedDay(DAY_RELEASE, DAILY_BUDGET_USD, 0);
    const at = middayOf(DAY_RELEASE);

    const refused = await reserve(ESTIMATE_USD, at);
    assert.equal(refused.ok, false, 'a full day granted a reservation');

    await release(ESTIMATE_USD, at);
    const afterRelease = await readBudget(at);
    assert.ok(
      Math.abs(afterRelease.reservedUsd - (DAILY_BUDGET_USD - ESTIMATE_USD)) < 1e-9,
      `release left reserved_usd at ${afterRelease.reservedUsd}, expected ${DAILY_BUDGET_USD - ESTIMATE_USD}`,
    );

    const granted = await reserve(ESTIMATE_USD, at);
    assert.equal(
      granted.ok,
      true,
      'the reservation released above was not usable again, so a call that never reached the provider still ' +
        'costs the day its headroom',
    );
  });

  it('moves a settled amount out of reserved and into spent, keeping the total honest', { skip: !DB_HOST ? 'DB_HOST not set' : false }, async () => {
    await seedDay(DAY_SETTLE, 1.0, 0);
    const at = middayOf(DAY_SETTLE);

    await settle({ estimateUsd: 1.0, actualUsd: 0.7 }, at);

    const snapshot = await readBudget(at);
    assert.ok(Math.abs(snapshot.reservedUsd) < 1e-9, `reserved_usd is ${snapshot.reservedUsd}, expected 0`);
    assert.ok(Math.abs(snapshot.spentUsd - 0.7) < 1e-9, `spent_usd is ${snapshot.spentUsd}, expected 0.7`);

    // THE CAP MUST STILL SEE THE SETTLED MONEY. This is the arithmetic that
    // silently disables the whole guard: a grant condition reading `reserved`
    // alone would find 0 committed here and hand out the entire day again.
    await settle({ estimateUsd: 0, actualUsd: DAILY_BUDGET_USD - 0.7 }, at);
    const full = await readBudget(at);
    assert.ok(Math.abs(full.spentUsd - DAILY_BUDGET_USD) < 1e-9, `spent_usd is ${full.spentUsd}, expected the cap`);
    assert.ok(Math.abs(full.reservedUsd) < 1e-9);

    const refused = await reserve(ESTIMATE_USD, at);
    assert.equal(
      refused.ok,
      false,
      'a day whose whole cap is in spent_usd still granted a reservation, so the grant condition reads ' +
        'reserved_usd alone and settling a call restores the headroom it consumed',
    );
  });

  it('drives neither column below zero, however much is released or settled', { skip: !DB_HOST ? 'DB_HOST not set' : false }, async () => {
    await seedDay(DAY_FLOOR, ESTIMATE_USD, 0);
    const at = middayOf(DAY_FLOOR);

    // Far more than was ever reserved. The overshoot must be absorbed, not
    // banked: a negative reserved_usd is free headroom for the rest of the day.
    await release(DAILY_BUDGET_USD * 10, at);
    const afterRelease = await readBudget(at);
    assert.ok(afterRelease.reservedUsd >= 0, `release drove reserved_usd to ${afterRelease.reservedUsd}`);
    assert.ok(Math.abs(afterRelease.reservedUsd) < 1e-9);

    await settle({ estimateUsd: DAILY_BUDGET_USD * 10, actualUsd: 0 }, at);
    const afterSettle = await readBudget(at);
    assert.ok(afterSettle.reservedUsd >= 0, `settle drove reserved_usd to ${afterSettle.reservedUsd}`);
    assert.ok(afterSettle.spentUsd >= 0, `settle drove spent_usd to ${afterSettle.spentUsd}`);

    // The floor must not have bought extra room either: the day still starts
    // from zero committed, so exactly the cap fits and no more.
    const granted = await reserve(DAILY_BUDGET_USD, at);
    assert.equal(granted.ok, true);
    const refused = await reserve(ESTIMATE_USD, at);
    assert.equal(refused.ok, false, 'the day granted more than the cap after an over-large release');
  });

  it('reads as exhausted at the cap and not below it', { skip: !DB_HOST ? 'DB_HOST not set' : false }, async () => {
    const at = middayOf(DAY_EXHAUSTED);

    await seedDay(DAY_EXHAUSTED, DAILY_BUDGET_USD - ESTIMATE_USD, 0);
    assert.equal(await isBudgetExhausted(at), false, 'a day below the cap read as exhausted, so the UI refuses work');

    // Split across both columns on purpose: the read has to add them, for the
    // same reason the grant condition does.
    await seedDay(DAY_EXHAUSTED, DAILY_BUDGET_USD - ESTIMATE_USD, ESTIMATE_USD);
    assert.equal(
      await isBudgetExhausted(at),
      true,
      'a day at the cap did not read as exhausted, so the entry page keeps offering work the cap will refuse',
    );
  });
});
