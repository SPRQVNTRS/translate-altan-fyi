/**
 * The global daily spend cap: reserve before the provider call, settle after it.
 *
 * RESERVE-THEN-RELEASE, NOT COUNT-AFTERWARDS. THIS IS THE WHOLE FILE.
 *   The caller reserves BEFORE the upstream call and never counts afterwards.
 *   The reverse order, forward first and count after, has a window in which N
 *   parallel requests all see the old count and all go through. The window is
 *   small and it is exactly what an unattended script hits. The rule and its
 *   wording come from `openplate-gateway/src/quota/types.ts`; what is NOT copied
 *   from there is the store, because that gateway keeps its counters in memory
 *   and in files. This service must survive a restart with its cap intact, so
 *   the store here is Postgres and the atomicity is the database's, not a
 *   mutex's.
 *
 * THE CAP IS IN CURRENCY, NOT IN REQUESTS.
 *   Models are priced per token and the per-request cost moves whenever the
 *   active model changes, so "N lookups a day" is a limit on an amount of money
 *   nobody has computed.
 *
 * NUMERICS ARRIVE AS STRINGS, AND THE CONVERSION HAPPENS HERE, ONCE.
 *   Postgres `numeric` holds values a JavaScript number cannot represent
 *   exactly, so Drizzle carries the column as a string in both directions. This
 *   module is the boundary where that string becomes a number, the same way
 *   `app/models/enrichments.server.ts` is the boundary for `cost_usd`.
 *   Converting anywhere else would mean two places rounding the same money.
 */

import { and, eq, sql } from 'drizzle-orm';

import { raiseAlert } from '#app/lib/alerts.server';
import { createComponentLogger } from '#app/lib/logger';
import { dailyBudget } from '#drizzle/schema';
import { getRawDb } from '#drizzle/tenant-db';

const log = createComponentLogger('AbuseBudget');

/**
 * What the installation is willing to spend on enrichment in one UTC day.
 *
 * A figure, not a policy knob: the product has no paid plan, so this is the
 * operator's own money and the only thing standing between a script and a bill.
 * Memory `feedback_shw_openrouter_key_shared_weekly_cap` records what a real key
 * running production traffic under a cap nobody watched actually costs.
 */
export const DAILY_BUDGET_USD = 3.0;

/** The fraction of the cap that raises the operator warning on the way past it. */
export const BUDGET_WARN_FRACTION = 0.8;

/** The scale of the `numeric(12, 6)` columns. Every figure sent to them is rounded to it exactly once. */
const MONEY_SCALE = 6;

/**
 * The UTC day key, `YYYY-MM-DD`.
 *
 * UTC and not a local zone, so the reset is one global instant. A local-midnight
 * reset would move with the server's zone, and a server moved between zones
 * would either grant a second day's budget or skip one.
 *
 * @param at any instant inside the day.
 */
export function utcDay(at: Date): string {
  return at.toISOString().slice(0, 10);
}

/** Today's money, as the admin page and the entry page read it. */
export interface BudgetSnapshot {
  day: string;
  reservedUsd: number;
  spentUsd: number;
  capUsd: number;
}

/** Whether a reservation was granted, with the figures the caller reports. */
export type ReserveOutcome =
  { ok: true; reservedUsd: number; capUsd: number } | { ok: false; reservedUsd: number; capUsd: number };

/** A money figure on its way into a `numeric` column, as a string Postgres can cast exactly. */
function money(value: number): string {
  return value.toFixed(MONEY_SCALE);
}

/** A money figure on its way out of a `numeric` column. */
function fromNumericColumn(value: string): number {
  return Number(value);
}

/**
 * Make sure today's row exists.
 *
 * SEPARATE FROM THE GRANT, AND IT GRANTS NOTHING. This insert can race with
 * another request's insert and the loser is a no-op, which is correct: both
 * callers only need the row to be there before the conditional update runs. The
 * decision itself is the single statement in `reserve` below, and no amount of
 * racing on this one can hand out spend.
 */
async function ensureDayRow(day: string): Promise<void> {
  const db = getRawDb();
  await db.insert(dailyBudget).values({ day }).onConflictDoNothing();
}

/**
 * Commit `estimateUsd` against today's cap, or refuse.
 *
 * THE GRANT IS ONE STATEMENT. The condition and the addition are evaluated
 * together by the database, so N parallel reservations against a cap yield
 * exactly the number that fit, never one more. No returned row means the
 * condition was false, which means refused: there is no separate read whose
 * answer could be stale by the time the write lands.
 *
 * THE CONDITION READS `reserved + spent`, NOT `reserved` ALONE.
 *   This is the arithmetic the whole cap depends on. `settle` moves a figure OUT
 *   of `reserved` and INTO `spent`, so a condition that looked only at
 *   `reserved` would see the day's headroom restored after every completed call
 *   and the cap would never bind, however much had actually been spent. The
 *   schema file states the same rule: the check reads `reserved + spent`.
 *
 * @param estimateUsd what the call is expected to cost. Never zero for a call
 *   that will really run: see the caller's comment on unpriced models.
 * @param at the instant to charge to, so the day arithmetic is testable.
 */
export async function reserve(estimateUsd: number, at: Date = new Date()): Promise<ReserveOutcome> {
  const day = utcDay(at);
  const cap = DAILY_BUDGET_USD;
  await ensureDayRow(day);

  const db = getRawDb();
  const rows = await db
    .update(dailyBudget)
    .set({ reservedUsd: sql`${dailyBudget.reservedUsd} + ${money(estimateUsd)}::numeric` })
    .where(
      and(
        eq(dailyBudget.day, day),
        sql`${dailyBudget.reservedUsd} + ${dailyBudget.spentUsd} + ${money(estimateUsd)}::numeric <= ${money(cap)}::numeric`,
      ),
    )
    .returning({ reservedUsd: dailyBudget.reservedUsd, spentUsd: dailyBudget.spentUsd });

  const granted = rows[0];
  if (granted === undefined) {
    // The refusal path may read, because nothing is being granted: the figures
    // are for the message, not for a decision.
    //
    // THE REFUSAL IS WHERE `budget-cap` ACTUALLY FIRES, and that is not a
    // shortcut. A granted reservation can never take the total ABOVE the cap,
    // because the condition above forbids it, so "the total reached the cap
    // exactly" is an event that essentially never happens with real estimates.
    // The first refusal is the honest moment the cap was reached, so the
    // crossing is evaluated with `newTotal` pinned at the cap. Every later
    // refusal of the day computes the same crossing and is swallowed by
    // `alert_log`'s primary key, so this stays one message per day.
    const snapshot = await readBudget(at);
    await raiseBudgetAlerts({ previousTotal: snapshot.reservedUsd + snapshot.spentUsd, newTotal: cap, capUsd: cap }, at);
    log.info('Enrichment refused by the daily budget cap', { day, estimateUsd, capUsd: cap });
    return { ok: false, reservedUsd: snapshot.reservedUsd, capUsd: cap };
  }

  const reservedUsd = fromNumericColumn(granted.reservedUsd);
  const newTotal = reservedUsd + fromNumericColumn(granted.spentUsd);
  await raiseBudgetAlerts({ previousTotal: newTotal - estimateUsd, newTotal, capUsd: cap }, at);
  return { ok: true, reservedUsd, capUsd: cap };
}

/**
 * Turn a reservation into a real spend.
 *
 * One statement, so the two columns can never be seen half moved. The estimate
 * leaves `reserved` and the actual figure lands in `spent`, which is why a
 * settle can move the day's total in either direction: a call that cost less
 * than estimated hands the difference back.
 *
 * NEITHER COLUMN MAY GO BELOW ZERO, and `greatest(0, ...)` is what enforces it.
 * An arithmetic slip, a double settle, a release of a reservation that was never
 * granted, must all degrade to a STRICTER cap and never to a free one. A
 * negative `reserved` would be free headroom that nobody ever paid for, and it
 * would persist for the rest of the day.
 *
 * @param params the figure that was reserved, and the figure the call really cost.
 * @param at the instant whose day to settle against.
 */
export async function settle(params: { estimateUsd: number; actualUsd: number }, at: Date = new Date()): Promise<void> {
  const db = getRawDb();
  await db
    .update(dailyBudget)
    .set({
      reservedUsd: sql`greatest(0, ${dailyBudget.reservedUsd} - ${money(params.estimateUsd)}::numeric)`,
      spentUsd: sql`greatest(0, ${dailyBudget.spentUsd} + ${money(params.actualUsd)}::numeric)`,
    })
    .where(eq(dailyBudget.day, utcDay(at)));
}

/**
 * Give a reservation back, for a call that failed without spending.
 *
 * Only when the provider was NOT reached. A model that answered badly still
 * burned the money, and releasing that would hand out a free retry loop, which
 * is the one failure mode a spend cap must not have.
 *
 * @param estimateUsd the figure that was reserved.
 * @param at the instant whose day to release against.
 */
export async function release(estimateUsd: number, at: Date = new Date()): Promise<void> {
  const db = getRawDb();
  await db
    .update(dailyBudget)
    .set({ reservedUsd: sql`greatest(0, ${dailyBudget.reservedUsd} - ${money(estimateUsd)}::numeric)` })
    .where(eq(dailyBudget.day, utcDay(at)));
}

/**
 * Today's figures, or zeroes when no row exists yet.
 *
 * A day nobody has spent on has no row, and that is the same fact as a row of
 * zeroes. Returning the zeroes rather than null keeps every caller free of a
 * null check that would only ever mean "before the first enrichment today".
 *
 * @param at the instant whose day to read.
 */
export async function readBudget(at: Date = new Date()): Promise<BudgetSnapshot> {
  const db = getRawDb();
  const day = utcDay(at);
  const rows = await db
    .select({ reservedUsd: dailyBudget.reservedUsd, spentUsd: dailyBudget.spentUsd })
    .from(dailyBudget)
    .where(eq(dailyBudget.day, day));

  const row = rows[0];
  if (row === undefined) return { day, reservedUsd: 0, spentUsd: 0, capUsd: DAILY_BUDGET_USD };

  return {
    day,
    reservedUsd: fromNumericColumn(row.reservedUsd),
    spentUsd: fromNumericColumn(row.spentUsd),
    capUsd: DAILY_BUDGET_USD,
  };
}

/**
 * Whether the cap looks reached.
 *
 * DELIBERATELY NOT AUTHORITATIVE, AND NOTHING MAY TREAT IT AS IF IT WERE.
 *   This is a plain read with no locking, used by the UI and by the vote path to
 *   EXPLAIN a state to a reader. `reserve` is the only thing that grants spend,
 *   and it is the only thing whose answer is safe under concurrency. A guard
 *   built on this function instead would be the count-afterwards mistake wearing
 *   a different name.
 *
 *   It is also coarse at the boundary: the last sliver of headroom, too small
 *   for any real reservation, still reads as available here. That direction is
 *   the safe one, because the request it lets through is then refused by
 *   `reserve` and the workflow writes an honest failed row.
 *
 * @param at the instant whose day to read.
 */
export async function isBudgetExhausted(at: Date = new Date()): Promise<boolean> {
  const snapshot = await readBudget(at);
  return snapshot.reservedUsd + snapshot.spentUsd >= snapshot.capUsd;
}

/**
 * Raise the operator alerts this reservation crossed, and only those.
 *
 * FIRE ON THE CROSSING, NOT ON THE CONDITION. Once the day is past the warning
 * threshold the condition "we are past the threshold" is true for every request
 * that follows, so an alert raised from the condition is an alert raised
 * hundreds of times, which is an alert nobody reads. A crossing is true exactly
 * once: the total before this reservation was under the line and the total after
 * it is not. `alert_log`'s primary key on (day, kind) is the second belt, for
 * two crossings computed by two processes in the same second.
 *
 * THE INSTANT IS THREADED, NOT TAKEN FROM THE CLOCK. `alert_log`'s dedupe is
 * keyed on a UTC day, and the day that matters is the one the spend was charged
 * to, which is the caller's `at`. Letting `raiseAlert` default to the process
 * clock would write the dedupe row under a different day from the budget row it
 * describes, and every other function in this module already takes the instant
 * as a parameter.
 *
 * @param params the totals before and after this reservation, and the cap.
 * @param at the instant the spend was charged to.
 */
async function raiseBudgetAlerts(
  params: { previousTotal: number; newTotal: number; capUsd: number },
  at: Date,
): Promise<void> {
  const warnAt = params.capUsd * BUDGET_WARN_FRACTION;

  if (params.previousTotal < warnAt && params.newTotal >= warnAt) {
    await raiseAlert(
      {
        kind: 'budget-warning',
        message: `Enrichment spend has passed ${Math.round(BUDGET_WARN_FRACTION * 100)}% of the daily cap.`,
        detail: { committedUsd: params.newTotal, capUsd: params.capUsd },
      },
      at,
    );
  }

  if (params.previousTotal < params.capUsd && params.newTotal >= params.capUsd) {
    await raiseAlert(
      {
        kind: 'budget-cap',
        message: 'Enrichment has reached the daily budget cap and is now refusing new work.',
        detail: { committedUsd: params.newTotal, capUsd: params.capUsd },
      },
      at,
    );
  }
}
