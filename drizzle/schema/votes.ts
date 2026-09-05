import { sql, type InferInsertModel, type InferSelectModel } from 'drizzle-orm';
import { pgTable, text, smallint, timestamp, uuid, integer, index, check, primaryKey } from 'drizzle-orm/pg-core';
import { users } from './users';
import { headwords, languages, translations } from './dictionary';
import { enrichments } from './enrichment';

// =============================================================================
// Enrichment votes and the re-enrichment cooldown
// =============================================================================
// A reader tells us whether the study notes on one enrichment helped, and a
// down-vote is what can put a headword back in the queue. A vote is a judgement
// about the shared dictionary, exactly like the enrichment it points at, so
// both are reached through `getRawDb()`.
//
// WHAT THIS FILE MUST NEVER CARRY
//   No headword, no sense, no query text, no language pair on `enrichment_votes`.
//   The product's claim is that looking a word up does not build a record of the
//   person looking it up, and this is the one table that holds both an account
//   and a dictionary object at once, so it is the one place that claim can be
//   lost. The enrichment id is a shared-zone object: it identifies a cached
//   answer, not a reader's search. Turning it back into a headword takes a
//   second read that nothing in the vote path performs. Adding a headword column
//   here would defeat the claim on its own, with no other change and no bug,
//   because the row would then say WHO looked up WHAT.
// =============================================================================

export const enrichmentVotes = pgTable(
  'enrichment_votes',
  {
    // `cascade` because a vote on an enrichment that no longer exists is
    // meaningless: it scores an answer nobody can read. That is a statement
    // about what a vote MEANS, not a prediction that enrichments get deleted.
    // Rows here are appended, and a delete is a rare repair.
    enrichmentId: uuid('enrichment_id')
      .notNull()
      .references(() => enrichments.id, { onDelete: 'cascade' }),
    // THE REAL USER, WITH A REAL FOREIGN KEY.
    //
    // The column keeps its `account_id` name and points at `users` since M191,
    // when the encrypted account model was replaced by a plain one. Renaming it
    // would be churn: nothing outside this file spells the column, and the row
    // still means "one reader's judgement".
    //
    // `cascade` for the same reason the enrichment link cascades: a vote by a
    // user who no longer exists scores an answer on behalf of nobody. It is
    // also what makes account deletion a single DELETE that leaves nothing
    // behind, which is the self-serve erasure path.
    accountId: integer('account_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** `-1` or `1`, pinned by the check constraint below. There is no neutral vote: not voting is the neutral case. */
    value: smallint('value').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [
    // THE COMPOSITE KEY IS THE RULE, AND IT IS WHAT MAKES A VOTE CHANGEABLE.
    //
    // "One vote per account per enrichment" is not enforced anywhere in the
    // application; it is this primary key. A reader who changes their mind
    // upserts on that key, so the second vote REPLACES the first instead of
    // adding a row beside it. Without the key a re-vote would be a second row,
    // the tally would count one person twice, and every reader would be able to
    // push a score as far as they liked by clicking again.
    primaryKey({ columns: [table.enrichmentId, table.accountId] }),

    check('enrichment_votes_value_check', sql`value in (-1, 1)`),

    // The primary key starts with `enrichmentId`, so it cannot serve a read that
    // starts from the account. "Which enrichments has this account voted on"
    // is what the entry page needs to show a reader their own vote.
    index('enrichment_votes_account_idx').on(table.accountId),
  ],
);

export type InsertEnrichmentVote = InferInsertModel<typeof enrichmentVotes>;
export type SelectEnrichmentVote = InferSelectModel<typeof enrichmentVotes>;

// =============================================================================
// Translation votes
// =============================================================================
// A reader tells us whether ONE translated word is right. Seven Turkish words
// for `umwerfen` are seven separate claims, and a reader who thinks one of them
// is wrong is saying so about that one, so the row points at a single
// `translations` edge rather than at the answer as a whole.
//
// THE PRIVACY RULE OF THIS FILE STILL HOLDS, AND HERE IS WHY IT HOLDS FOR AN
// EDGE.
//   A translation id names a dictionary EDGE: the assertion that one sense in
//   one language is rendered by one sense in another, written by a source. It
//   is an object in the shared zone, exactly like an enrichment, and it exists
//   whether or not anybody ever searched for it. Turning it into a word takes a
//   second read, through `senses` to `headwords`, and nothing in the vote path
//   performs that read. So a row here says "this reader judged this edge", not
//   "this reader looked this word up".
//
//   That distinction survives only as long as this table stays this narrow. No
//   headword, no lemma, no query text and no language pair may be added to it.
//   Any one of those columns would put the word and the reader on the same row,
//   and the claim would be lost with no bug and no other change, because the row
//   would then say WHO looked up WHAT.
//
// WHAT A VOTE DOES, TODAY: it is recorded, and nothing else. No translation is
// re-run, hidden or re-ordered because of its score (M194 decision 8). The rows
// are the signal; what to do with them is a decision to take on real data, and
// the operator's list at `/super/llm` is the only thing built on top of them.
// =============================================================================

export const translationVotes = pgTable(
  'translation_votes',
  {
    // `cascade` for the same reason the enrichment link cascades: a vote on an
    // edge that no longer exists scores an assertion nobody can read.
    translationId: uuid('translation_id')
      .notNull()
      .references(() => translations.id, { onDelete: 'cascade' }),
    // `cascade` again, and it is also what makes account deletion a single
    // DELETE that leaves nothing behind, which is the self-serve erasure path.
    accountId: integer('account_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** `-1` or `1`, pinned by the check constraint below. There is no neutral vote: not voting is the neutral case. */
    value: smallint('value').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [
    // THE COMPOSITE KEY IS THE RULE. "One vote per reader per edge" is not
    // enforced anywhere in the application; it is this primary key. A reader who
    // changes their mind upserts on it, so the second vote REPLACES the first.
    // Without the key a re-vote would be a second row, the tally would count one
    // person twice, and any reader could push a score as far as they liked by
    // clicking again.
    primaryKey({ columns: [table.translationId, table.accountId] }),

    check('translation_votes_value_check', sql`value in (-1, 1)`),

    // The primary key starts with `translationId`, so it cannot serve a read
    // that starts from the account. "Which translations has this account voted
    // on" is what the search pane needs to show a reader their own vote.
    index('translation_votes_account_idx').on(table.accountId),
  ],
);

export type InsertTranslationVote = InferInsertModel<typeof translationVotes>;
export type SelectTranslationVote = InferSelectModel<typeof translationVotes>;

// =============================================================================
// Re-enrichment cooldown
// =============================================================================
// THIS IS A SPEND GUARD, NOT BOOKKEEPING.
//
// A re-enrichment is a paid model call. Without a cooldown, a small group of
// readers can queue one for the same headword as often as they can click, and
// the bill is theirs to set rather than ours. One row per (headword, direction)
// records when that pair was last queued; the queueing path upserts the row and
// refuses a request that arrives inside the window.
//
// The grain is the headword AND the direction because that is what a re-run
// actually costs. The same word from German into English and from English into
// German are two separate model calls, so a cooldown keyed on the headword alone
// would let one direction's request silently block the other's.
// =============================================================================

export const reenrichmentLog = pgTable(
  'reenrichment_log',
  {
    headwordId: uuid('headword_id')
      .notNull()
      .references(() => headwords.id),
    fromLanguageCode: text('from_language_code')
      .notNull()
      .references(() => languages.code),
    toLanguageCode: text('to_language_code')
      .notNull()
      .references(() => languages.code),
    /** Overwritten on every queued re-enrichment. The row is a cursor, not a history. */
    lastQueuedAt: timestamp('last_queued_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [primaryKey({ columns: [table.headwordId, table.fromLanguageCode, table.toLanguageCode] })],
);

export type InsertReenrichmentLogEntry = InferInsertModel<typeof reenrichmentLog>;
export type SelectReenrichmentLogEntry = InferSelectModel<typeof reenrichmentLog>;
