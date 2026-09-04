/**
 * The pure half of the daily spend cap: which day a spend is charged to, and
 * what the two figures behind the cap are.
 *
 * WHAT THIS FILE HOLDS IN PLACE
 *   `utcDay` picks the row of `daily_budget` that a reservation is charged
 *   against. Every other guarantee in `app/lib/abuse/budget.server.ts` is built
 *   on top of it, and it is the one part of the module that can be wrong without
 *   any statement failing.
 *
 *   THE DAY MUST BE UTC. A local-zone day would move with the server's zone: a
 *   host in UTC+14 would roll its budget fourteen hours early, so a deployment
 *   moved between zones, or two processes in different zones, would either grant
 *   a second day of spend or skip a day. This file therefore sets `TZ` to a zone
 *   far from UTC before importing the module, and every day case is written at
 *   an instant where the local day and the UTC day DIFFER. A test run in UTC
 *   cannot tell the two implementations apart, so the premise that they differ
 *   is asserted first: without it these cases would pass on a local-time
 *   implementation and prove nothing.
 *
 *   The two constants are asserted against the figures the spec fixed. They are
 *   the operator's own money, and `BUDGET_WARN_FRACTION` is only useful if it is
 *   strictly below the cap: a warning that fires at the cap arrives at the same
 *   moment as the refusal it was meant to precede.
 *
 * NO DATABASE. `budget.server.ts` imports `#drizzle/db`, which imports
 * `drizzle/db.ts`, which CONNECTS at module load and retries for about a minute.
 * That import is mocked out before the module under test is loaded, so nothing
 * here opens a pool. Everything that writes a row belongs to the integration
 * tier.
 */
import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';

/**
 * A zone fourteen hours ahead of UTC, set BEFORE any date is constructed.
 *
 * The point of the whole file: at 22:00 UTC the local calendar in this zone is
 * already on the next day, so a `utcDay` written with local getters returns a
 * different string from one written with `toISOString`.
 */
process.env.TZ = 'Pacific/Kiritimati';

// The mock must be installed BEFORE the module under test is imported, so the
// import below is dynamic and this call is at the top level. `getRawDb` throws:
// nothing in this file may reach it.
mock.module('#drizzle/db', {
  namedExports: {
    getRawDb: () => {
      throw new Error('the unit tier must not reach a database');
    },
  },
});

const { utcDay, BUDGET_WARN_FRACTION, DAILY_BUDGET_USD } = await import('#app/lib/abuse/budget.server');

/** An instant late in a UTC day, which the test zone already calls the NEXT day. */
const LATE_IN_THE_UTC_DAY = new Date('2026-03-05T22:00:00.000Z');

describe('abuse: the budget day', () => {
  it('is the UTC day, not the local one', () => {
    // The premise first. If the process were running in UTC this case could not
    // discriminate between the two implementations, so it would be worthless
    // and should say so rather than pass.
    assert.equal(
      LATE_IN_THE_UTC_DAY.getDate(),
      6,
      'the test process is not running in a zone ahead of UTC, so this case cannot tell a UTC day from a local one',
    );

    assert.equal(
      utcDay(LATE_IN_THE_UTC_DAY),
      '2026-03-05',
      'the budget day follows the local zone, so the cap resets when the server moves zones',
    );
  });

  it('is the same string for the whole of one UTC day', () => {
    const justAfterMidnight = new Date('2026-03-05T00:00:00.000Z');
    const midday = new Date('2026-03-05T12:34:56.789Z');
    const justBeforeMidnight = new Date('2026-03-05T23:59:59.999Z');

    assert.equal(utcDay(justAfterMidnight), '2026-03-05');
    assert.equal(utcDay(midday), '2026-03-05');
    assert.equal(utcDay(justBeforeMidnight), '2026-03-05');
  });

  it('rolls at UTC midnight and not before it', () => {
    const lastMillisecond = new Date('2026-03-05T23:59:59.999Z');
    const firstMillisecond = new Date('2026-03-06T00:00:00.000Z');

    assert.notEqual(
      utcDay(lastMillisecond),
      utcDay(firstMillisecond),
      'the day did not roll at UTC midnight, so one calendar day carries two days of budget',
    );
    assert.equal(utcDay(firstMillisecond), '2026-03-06');
  });

  it('rolls across a year boundary', () => {
    assert.equal(utcDay(new Date('2026-12-31T23:59:59.999Z')), '2026-12-31');
    assert.equal(utcDay(new Date('2027-01-01T00:00:00.000Z')), '2027-01-01');
  });

  it('is the YYYY-MM-DD shape the date column takes', () => {
    // Zero padding is part of the contract: the column is a `date` and the
    // string is compared as a key, so '2026-3-5' would be a different row.
    assert.equal(utcDay(new Date('2026-01-02T09:00:00.000Z')), '2026-01-02');
    assert.match(utcDay(new Date('2026-01-02T09:00:00.000Z')), /^\d{4}-\d{2}-\d{2}$/);
  });
});

describe('abuse: the cap and the warning level', () => {
  it('caps the day at the figure the spec fixed', () => {
    assert.equal(
      DAILY_BUDGET_USD,
      3.0,
      'the daily cap is not 3.00 USD. This is the money of the operator, and the figure is not a knob: ' +
        'changing it is a decision, not a refactor.',
    );
  });

  it('warns at the fraction of the cap the spec fixed', () => {
    assert.equal(BUDGET_WARN_FRACTION, 0.8);
  });

  it('puts the warning level strictly below the cap', () => {
    const warnAt = DAILY_BUDGET_USD * BUDGET_WARN_FRACTION;

    assert.ok(
      warnAt < DAILY_BUDGET_USD,
      `the warning level (${warnAt}) is not below the cap (${DAILY_BUDGET_USD}), so the operator hears about ` +
        'the spend at the same moment work starts being refused, which is too late to act on',
    );
    assert.ok(warnAt > 0, 'the warning level is at or below zero, so it fires on the first reservation of every day');
    // Compared with a tolerance, because 3 * 0.8 is not exactly 2.4 in binary
    // floating point. The figure is what matters, not the representation.
    assert.ok(Math.abs(warnAt - 2.4) < 1e-9, `the warning level is ${warnAt}, not 2.40 USD`);
  });
});
