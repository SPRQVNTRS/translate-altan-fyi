import { sql, type InferInsertModel, type InferSelectModel } from 'drizzle-orm';
import { pgTable, text, integer, numeric, date, timestamp, check, primaryKey } from 'drizzle-orm/pg-core';

// =============================================================================
// Abuse counters, spend cap and operator alerts (Global, NOT tenant-scoped)
// =============================================================================
// EVERY ROW IN THIS FILE IS ANONYMOUS. THAT IS THE GOVERNING RULE.
//
// No headword, no account id, no user id, no raw IP address, in any column of
// any table here, ever. These tables exist to stop one visitor from spending the
// project's money, and the cheapest way to do that would be to write down who
// the visitor is and what they asked for. That is a search log wearing a
// different hat, and it would undo the one promise the product makes: that
// looking a word up does not build a record of the person looking it up. A
// counter that can be joined back to a person is exactly that record, whatever
// the column is called.
//
// What survives the rule is a HASH and a COUNT. Rate limiting only ever needs to
// know "has this bucket already had its share", which is answerable without
// knowing whose bucket it is.
//
// The budget is the installation's, the rate limit protects the installation,
// and both are reached through `getRawDb()`.
// =============================================================================

// A FIXED WINDOW, NOT A SLIDING ONE.
//
// `windowStart` is the floor of the hour in UTC, so every request in one hour
// increments one row and the check is a single indexed read of a key we can
// compute without touching the table. The trade is bought deliberately: a fixed
// window lets a visitor spend two windows' worth of requests across a boundary.
// A sliding window would need the timestamps of individual requests, which is
// per-request evidence of a person's activity, and the whole point of this file
// is not to hold that. The other half of the trade is cleanup: an expired row is
// dead weight a sweep can delete, never a wrong answer, because a lookup only
// ever asks for the CURRENT window's key.
//
// `key` is a peppered hash, written as `ip:<hash>` or `session:<hash>`, and
// never a raw address or a raw session id. The prefix says which kind of bucket
// it is so the two cannot collide. The pepper is what stops the table from being
// a reversible list of visitors: an attacker holding a dump can hash a guessed
// address only if they also hold the pepper, which lives outside the database.
export const abuseCounters = pgTable(
  'abuse_counters',
  {
    /** `ip:<hash>` or `session:<hash>`. NEVER a raw address or a raw session id, see the comment above. */
    key: text('key').notNull(),
    /** The floor of the hour, in UTC. Computed by the caller, never `now()`, so the row is deterministic. */
    windowStart: timestamp('window_start', { withTimezone: true }).notNull(),
    count: integer('count').default(0).notNull(),
  },
  (table) => [primaryKey({ columns: [table.key, table.windowStart] })],
);

export type InsertAbuseCounter = InferInsertModel<typeof abuseCounters>;
export type SelectAbuseCounter = InferSelectModel<typeof abuseCounters>;

// THE CAP IS IN CURRENCY, NOT IN REQUESTS.
//
// A request count is not a spend limit. Models are priced per token and the
// per-request cost moves whenever the active model changes, so a limit of "N
// lookups a day" is a limit on an amount of money nobody has computed. One row
// per UTC day holds the real figure.
//
// WHY `reserved` IS SEPARATE FROM `spent`
//   The reservation is taken BEFORE the provider call, from the estimated cost.
//   The true figure only exists after the response comes back, and is then moved
//   into `spent`. A cap that can only be evaluated after the spend is not a cap,
//   it is a report: without the reservation, a hundred concurrent requests all
//   read the same low `spent`, all pass, and all charge. Holding both columns
//   means the check reads `reserved + spent` and a request that would cross the
//   line is refused before any money is committed.
//
// `numeric` and not a float, because this is money. A binary float cannot hold a
// decimal fraction exactly, so a running total accumulates error, and a cap
// compared against a drifting total is not the cap that was configured.
export const dailyBudget = pgTable('daily_budget', {
  /** The UTC day, `YYYY-MM-DD`. UTC and not a local zone, so the day does not move with the server. */
  day: date('day').primaryKey(),
  /** Committed before the provider call, from the estimate. Released or moved into `spentUsd` afterwards. */
  reservedUsd: numeric('reserved_usd', { precision: 12, scale: 6 }).default('0').notNull(),
  /** The real figure, known only after the response. */
  spentUsd: numeric('spent_usd', { precision: 12, scale: 6 }).default('0').notNull(),
});

export type InsertDailyBudget = InferInsertModel<typeof dailyBudget>;
export type SelectDailyBudget = InferSelectModel<typeof dailyBudget>;

// The counts the admin page reads: how much was turned away today, and which of
// the two guards did it. A refusal is otherwise invisible, so without this table
// a cap set too low looks exactly like a quiet day.
//
// There are TWO reasons and no more, pinned by a check constraint. The
// constraint is not decoration: the writer is a string literal at a call site,
// and a typo would silently open a third bucket that the admin page does not
// read and nobody notices. Adding a real third reason is then a migration, which
// is the point at which somebody decides what the page should do with it.
export const abuseRejections = pgTable(
  'abuse_rejections',
  {
    /** The UTC day, `YYYY-MM-DD`, matching `daily_budget.day`. */
    day: date('day').notNull(),
    /** `rate-limited` or `budget`, pinned by the check constraint below. */
    reason: text('reason').notNull(),
    count: integer('count').default(0).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.day, table.reason] }),
    check('abuse_rejections_reason_check', sql`reason in ('rate-limited', 'budget')`),
  ],
);

export type InsertAbuseRejection = InferInsertModel<typeof abuseRejections>;
export type SelectAbuseRejection = InferSelectModel<typeof abuseRejections>;

// THE ONCE-PER-DAY DEDUPE FOR THE OPERATOR ALERT.
//
// The budget condition is true on every request after it is first met, so an
// alert raised straight from the condition fires on every request for the rest
// of the day. An alert that fires that often is an alert nobody reads, and the
// one that matters next week is buried in it. The primary key on (day, kind) IS
// the dedupe: the sender inserts and treats a conflict as "already raised", so
// the second attempt of the day is a no-op rather than a second message.
//
// Two kinds, pinned by a check constraint for the same reason as the rejection
// reasons above: a misspelled kind would be a NEW key, so it would defeat the
// dedupe rather than fail, and the alert would go back to firing every time.
export const alertLog = pgTable(
  'alert_log',
  {
    /** The UTC day, `YYYY-MM-DD`, matching `daily_budget.day`. */
    day: date('day').notNull(),
    /** `budget-warning` or `budget-cap`, pinned by the check constraint below. */
    kind: text('kind').notNull(),
    raisedAt: timestamp('raised_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.day, table.kind] }),
    check('alert_log_kind_check', sql`kind in ('budget-warning', 'budget-cap')`),
  ],
);

export type InsertAlertLogEntry = InferInsertModel<typeof alertLog>;
export type SelectAlertLogEntry = InferSelectModel<typeof alertLog>;
