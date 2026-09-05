/**
 * Votes on one translation edge, and the operator's view of the bad ones.
 *
 * THE DATABASE IS A PARAMETER, NEVER AN IMPORT.
 *   The same rule `app/models/votes.server.ts` follows, for the same reason:
 *   `drizzle/db.ts` opens a connection pool at module load, and this module is
 *   reached from a route action holding `getRawDb()` and from an admin page
 *   holding its own handle. Only the TYPE is imported, so importing this file
 *   opens nothing.
 *
 * EVERY TABLE HERE IS SHARED. `translation_votes` and `translations` both
 * describe the one dictionary this installation serves, so `getRawDb()` is the
 * correct handle and no filter narrows these statements to a reader.
 *
 * THE PRIVACY RULE THAT SHAPES THE READS.
 *   A vote row holds a translation id and an account id and nothing else, and
 *   the file comment in `drizzle/schema/votes.ts` says why that is safe. The
 *   two reads a reader's own browser triggers, `castTranslationVote` and
 *   `tallyTranslationVotes`, never reach `senses` or `headwords`, so no
 *   statement on the reader's path holds an account id and a word at the same
 *   time.
 *
 *   `listDownVotedTranslations` DOES name words, and it is sound for a reason
 *   worth stating rather than assuming. It starts from the votes, unlike
 *   `listFlaggedForReview` next door, so it has to earn the claim differently:
 *   it groups the account column away before anything is selected, and the
 *   account column is neither selected nor filtered on. What comes out is "this
 *   edge scored badly", never "this reader judged this word". Selecting
 *   `accountId` here, or filtering by it, would turn the operator's page into
 *   the search log this product says it does not keep.
 */

import { alias } from 'drizzle-orm/pg-core';
import { desc, eq, sql } from 'drizzle-orm';

import type { DictionaryDb } from '#app/lib/dictionary/queries.server';
import type { VoteTally } from '#app/lib/votes/score';
import type { VoteValue } from '#app/models/votes.server';
import { headwords, senses, translationVotes, translations } from '#drizzle/schema';

/**
 * The two counted expressions every tally here shares.
 *
 * ONE QUERY, NOT TWO. `count(*) filter (where ...)` computes both directions in
 * a single pass over the same index range, and two round trips would also be
 * two MOMENTS: a vote landing between them produces a tally that never existed.
 */
const UP_COUNT = sql<number>`count(*) filter (where ${translationVotes.value} = 1)`.mapWith(Number);
const DOWN_COUNT = sql<number>`count(*) filter (where ${translationVotes.value} = -1)`.mapWith(Number);

export interface CastTranslationVoteParams {
  translationId: string;
  accountId: number;
  value: VoteValue;
}

/**
 * Record one reader's vote on one edge, replacing their previous one.
 *
 * THE UPSERT IS THE "ONE VOTE PER READER PER EDGE" RULE, AND IT IS NOT
 * OPTIONAL. The target is the composite primary key
 * `(translationId, accountId)`. A plain insert would append a second row, the
 * tally would count one person twice, and anybody could push a score as far as
 * they liked by clicking again.
 *
 * @param db The database handle.
 * @param params The edge, the account, and the direction of the vote.
 */
export async function castTranslationVote(db: DictionaryDb, params: CastTranslationVoteParams): Promise<void> {
  await db
    .insert(translationVotes)
    .values({
      translationId: params.translationId,
      accountId: params.accountId,
      value: params.value,
    })
    .onConflictDoUpdate({
      target: [translationVotes.translationId, translationVotes.accountId],
      // `updatedAt` is moved explicitly. Drizzle's `$onUpdate` fires on its own
      // `update` statements, not inside a conflict clause, so leaving it out
      // would freeze the column at the time of the reader's FIRST vote.
      set: { value: params.value, updatedAt: new Date() },
    });
}

/**
 * The up and down counts for one edge.
 *
 * @param db The database handle.
 * @param translationId The edge to count votes for.
 * @returns both counts, zeroed when nobody has voted.
 */
export async function tallyTranslationVotes(db: DictionaryDb, translationId: string): Promise<VoteTally> {
  const [row] = await db
    .select({ up: UP_COUNT, down: DOWN_COUNT })
    .from(translationVotes)
    .where(eq(translationVotes.translationId, translationId));

  return { up: row?.up ?? 0, down: row?.down ?? 0 };
}

/**
 * Whether this id names a real edge.
 *
 * READ BEFORE THE VOTE IS CAST. `translation_votes.translationId` is a foreign
 * key, so inserting against an unknown id would fail as a database error deep
 * in the action; reading first turns a stale id from an old open tab into an
 * ordinary 400. The function returns the id rather than a boolean so the caller
 * writes the value the DATABASE confirmed, not the one the browser sent.
 *
 * @param db The database handle.
 * @param translationId The edge to look for.
 * @returns the id, or `null` when nothing carries it.
 */
export async function readTranslationEdge(db: DictionaryDb, translationId: string): Promise<string | null> {
  const [row] = await db
    .select({ id: translations.id })
    .from(translations)
    .where(eq(translations.id, translationId))
    .limit(1);

  return row?.id ?? null;
}

/** One down-voted edge, as the operator's page renders it. */
export interface DownVotedTranslationView {
  translationId: string;
  /** The translated word itself, which is what the reader judged. */
  lemma: string;
  /** The language the word was looked up in. */
  fromLanguageCode: string;
  /** The language it was translated into. */
  toLanguageCode: string;
  up: number;
  down: number;
  /** When the most recent vote on this edge landed, which is what "newest first" orders by. */
  lastVotedAt: Date;
}

/**
 * Every edge a reader has voted down, worst-hit first by recency.
 *
 * NEWEST FIRST MEANS NEWEST VOTE, NOT NEWEST EDGE. The operator is reading a
 * complaint queue: an edge imported two years ago that was voted down this
 * morning is the one to look at, and ordering by the edge's own `createdAt`
 * would bury it under freshly generated rows nobody has judged.
 *
 * A ROW APPEARS AS SOON AS IT HAS ONE DOWN-VOTE, with no minimum and no score
 * threshold. Nothing automatic hangs off this list (M194 decision 8), so the
 * cost of showing a row too early is a person reading one extra line, and the
 * cost of hiding it is a signal nobody sees. The `up` count is beside it so the
 * reader can tell a disputed word from a rejected one.
 *
 * @param db The database handle.
 * @param limit How many rows to return.
 * @returns the edges, with their word and their direction.
 */
export async function listDownVotedTranslations(db: DictionaryDb, limit: number): Promise<DownVotedTranslationView[]> {
  const fromSenses = alias(senses, 'from_senses');
  const fromHeadwords = alias(headwords, 'from_headwords');
  const toSenses = alias(senses, 'to_senses');
  const toHeadwords = alias(headwords, 'to_headwords');

  return (
    db
      .select({
        translationId: translations.id,
        lemma: toHeadwords.lemma,
        fromLanguageCode: fromHeadwords.languageCode,
        toLanguageCode: toHeadwords.languageCode,
        up: UP_COUNT,
        down: DOWN_COUNT,
        lastVotedAt: sql<Date>`max(${translationVotes.updatedAt})`,
      })
      .from(translationVotes)
      .innerJoin(translations, eq(translations.id, translationVotes.translationId))
      .innerJoin(fromSenses, eq(fromSenses.id, translations.fromSenseId))
      .innerJoin(fromHeadwords, eq(fromHeadwords.id, fromSenses.headwordId))
      .innerJoin(toSenses, eq(toSenses.id, translations.toSenseId))
      .innerJoin(toHeadwords, eq(toHeadwords.id, toSenses.headwordId))
      // The grouping is what removes the account column from the answer. Every
      // selected expression is either grouped or aggregated, so no row that
      // leaves this statement can be traced back to one reader.
      .groupBy(translations.id, toHeadwords.lemma, fromHeadwords.languageCode, toHeadwords.languageCode)
      .having(sql`count(*) filter (where ${translationVotes.value} = -1) > 0`)
      .orderBy(desc(sql`max(${translationVotes.updatedAt})`))
      .limit(limit)
  );
}
