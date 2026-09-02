/**
 * Enrichment votes, the review flag, and the re-enrichment cooldown.
 *
 * THE DATABASE IS A PARAMETER, NEVER AN IMPORT.
 *   The same rule `app/models/enrichments.server.ts` follows, for the same
 *   reason: `drizzle/db.ts` opens a connection pool at module load, and this
 *   module is reached from a route action holding `getRawDb()` and, later, from
 *   an admin page holding its own handle. Only the TYPE is imported, so
 *   importing this file opens nothing.
 *
 * EVERY TABLE HERE IS GLOBAL.
 *   None of `enrichment_votes`, `reenrichment_log` or `enrichments` carries an
 *   `organizationId`, and none is in TENANT_TABLES, so `getRawDb()` is the
 *   correct handle and no `tdb.scope(...)` filter belongs on these statements.
 *
 * THE PRIVACY RULE THAT SHAPES THE READS.
 *   A vote row holds an enrichment id and an account id and nothing else, and
 *   the two reads a reader's own browser triggers, `tallyVotes` and
 *   `readVotesForAccount`, must not widen that. Neither joins to `headwords`,
 *   neither selects a lemma, and neither returns anything that says WHAT was
 *   looked up. `listFlaggedForReview` does join the lemma, and that is sound
 *   for the opposite reason: it starts from the review flag and never touches
 *   `enrichment_votes`' account column, so it names words without naming
 *   readers. See the file comment in `drizzle/schema/votes.ts`.
 */

import { and, desc, eq, inArray, sql } from 'drizzle-orm';

import type { DictionaryDb } from '#app/lib/dictionary/queries.server';
import type { VoteTally } from '#app/lib/votes/score';
import { enrichmentVotes, enrichments, headwords, reenrichmentLog } from '#drizzle/schema';

/** The only two values the check constraint on `enrichment_votes.value` allows. */
export type VoteValue = -1 | 1;

/**
 * The two counted expressions both tallies share.
 *
 * ONE QUERY, NOT TWO. `count(*) filter (where ...)` computes both directions in
 * a single pass over the same index range. Two round trips would also be two
 * MOMENTS: a vote landing between them produces a tally that never existed, and
 * the re-enrichment decision downstream is taken from exactly that number.
 */
const UP_COUNT = sql<number>`count(*) filter (where ${enrichmentVotes.value} = 1)`.mapWith(Number);
const DOWN_COUNT = sql<number>`count(*) filter (where ${enrichmentVotes.value} = -1)`.mapWith(Number);

export interface CastVoteParams {
  enrichmentId: string;
  accountId: number;
  value: VoteValue;
}

/**
 * Record one reader's vote, replacing their previous one.
 *
 * THE UPSERT IS THE "ONE VOTE PER READER" RULE, AND IT IS NOT OPTIONAL.
 *   The target is the composite primary key `(enrichmentId, accountId)`. A
 *   reader who changes their mind REPLACES their row. A plain insert would
 *   append a second row, the tally would count one person twice, and anybody
 *   could push a score as far as they liked by clicking again, which is the
 *   thing the whole re-enrichment path spends money on.
 *
 * @param db The database handle.
 * @param params The enrichment, the account, and the direction of the vote.
 */
export async function castVote(db: DictionaryDb, params: CastVoteParams): Promise<void> {
  await db
    .insert(enrichmentVotes)
    .values({
      enrichmentId: params.enrichmentId,
      accountId: params.accountId,
      value: params.value,
    })
    .onConflictDoUpdate({
      target: [enrichmentVotes.enrichmentId, enrichmentVotes.accountId],
      // `updatedAt` is moved explicitly. Drizzle's `$onUpdate` fires on its own
      // `update` statements, not inside a conflict clause, so leaving it out
      // would freeze the column at the time of the reader's FIRST vote.
      set: { value: params.value, updatedAt: new Date() },
    });
}

/**
 * The up and down counts for one enrichment.
 *
 * @param db The database handle.
 * @param enrichmentId The enrichment to count votes for.
 * @returns both counts, zeroed when nobody has voted.
 */
export async function tallyVotes(db: DictionaryDb, enrichmentId: string): Promise<VoteTally> {
  const [row] = await db
    .select({ up: UP_COUNT, down: DOWN_COUNT })
    .from(enrichmentVotes)
    .where(eq(enrichmentVotes.enrichmentId, enrichmentId));

  return { up: row?.up ?? 0, down: row?.down ?? 0 };
}

export interface ReadVotesForAccountParams {
  enrichmentIds: string[];
  accountId: number;
}

/**
 * Which of these enrichments this reader has already voted on, and how.
 *
 * AN EMPTY LIST RETURNS EARLY, AND THAT IS A CORRECTNESS GUARD.
 *   `inArray(column, [])` renders `in ()`, which Postgres rejects as a syntax
 *   error. An entry page with no cached enrichments is an ordinary page, not an
 *   error, so the empty case is answered without a statement.
 *
 * @param db The database handle.
 * @param params The enrichments on the page, and the reader.
 * @returns a map from enrichment id to that reader's vote. Absent means no vote.
 */
export async function readVotesForAccount(
  db: DictionaryDb,
  params: ReadVotesForAccountParams,
): Promise<Map<string, VoteValue>> {
  const votes = new Map<string, VoteValue>();
  if (params.enrichmentIds.length === 0) return votes;

  const rows = await db
    .select({ enrichmentId: enrichmentVotes.enrichmentId, value: enrichmentVotes.value })
    .from(enrichmentVotes)
    .where(
      and(inArray(enrichmentVotes.enrichmentId, params.enrichmentIds), eq(enrichmentVotes.accountId, params.accountId)),
    );

  for (const row of rows) {
    // `value` is a `smallint`, so Drizzle hands back a plain number. The check
    // constraint already pins it to -1 or 1, so the comparison narrows rather
    // than validates: it exists to produce the literal type without an
    // assertion, and a row that somehow held anything else would read as a
    // down-vote, which is the conservative direction.
    votes.set(row.enrichmentId, row.value === 1 ? 1 : -1);
  }

  return votes;
}

/**
 * Mark one enrichment for a human to look at.
 *
 * This is the answer for a down-voted row that is ALREADY on the current model
 * and prompt version: re-running identical input through an identical model
 * under an identical prompt spends money to reproduce the reader's complaint.
 * Flagging is the only other thing there is to do.
 *
 * @param db The database handle.
 * @param enrichmentId The enrichment to flag.
 */
export async function flagForReview(db: DictionaryDb, enrichmentId: string): Promise<void> {
  await db.update(enrichments).set({ flaggedForReview: true }).where(eq(enrichments.id, enrichmentId));
}

/** One flagged enrichment, as the admin review page renders it. */
export interface FlaggedEnrichmentView {
  enrichmentId: string;
  headwordId: string;
  lemma: string;
  model: string;
  promptVersion: number;
  createdAt: Date;
  up: number;
  down: number;
}

/**
 * The review queue, newest first.
 *
 * The vote table is joined with a LEFT join on purpose. A row can be flagged and
 * then have its votes deleted with the reader's account, and an inner join would
 * make that row vanish from the queue silently. With a left join the counts read
 * zero and the flag is still visible, which is the honest answer: something was
 * flagged and the evidence is gone.
 *
 * @param db The database handle.
 * @param limit How many rows to return.
 * @returns the flagged enrichments with their lemma and vote counts.
 */
export async function listFlaggedForReview(db: DictionaryDb, limit: number): Promise<FlaggedEnrichmentView[]> {
  return (
    db
      .select({
        enrichmentId: enrichments.id,
        headwordId: enrichments.headwordId,
        lemma: headwords.lemma,
        model: enrichments.model,
        promptVersion: enrichments.promptVersion,
        createdAt: enrichments.createdAt,
        up: UP_COUNT,
        down: DOWN_COUNT,
      })
      .from(enrichments)
      .innerJoin(headwords, eq(headwords.id, enrichments.headwordId))
      .leftJoin(enrichmentVotes, eq(enrichmentVotes.enrichmentId, enrichments.id))
      .where(eq(enrichments.flaggedForReview, true))
      // `enrichments.id` is the primary key, so Postgres treats every other
      // selected `enrichments` column as functionally dependent on it and needs no
      // further grouping. `headwords.lemma` comes from the joined table and has no
      // such dependency, so it is grouped explicitly.
      .groupBy(enrichments.id, headwords.lemma)
      .orderBy(desc(enrichments.createdAt))
      .limit(limit)
  );
}

/** One (headword, direction) pair, which is the grain the cooldown is kept at. */
export interface ReenrichmentKey {
  headwordId: string;
  from: string;
  to: string;
}

/** The three equality predicates both cooldown statements share. */
function matchesReenrichmentKey(key: ReenrichmentKey) {
  return and(
    eq(reenrichmentLog.headwordId, key.headwordId),
    eq(reenrichmentLog.fromLanguageCode, key.from),
    eq(reenrichmentLog.toLanguageCode, key.to),
  );
}

/**
 * When a re-enrichment was last queued for this pair.
 *
 * @param db The database handle.
 * @param params The headword and the direction.
 * @returns the timestamp, or `null` when one was never queued.
 */
export async function readReenrichmentCooldown(db: DictionaryDb, params: ReenrichmentKey): Promise<Date | null> {
  const [row] = await db
    .select({ lastQueuedAt: reenrichmentLog.lastQueuedAt })
    .from(reenrichmentLog)
    .where(matchesReenrichmentKey(params))
    .limit(1);

  return row?.lastQueuedAt ?? null;
}

/**
 * Move this pair's cooldown cursor to `at`.
 *
 * The row is a CURSOR, not a history: the upsert overwrites the previous
 * timestamp rather than appending beside it, which is why there is one row per
 * pair and no id column to order by.
 *
 * WRITE THIS ONLY AFTER A JOB IS ACTUALLY QUEUED. Touching it on a refused
 * request would make the refusal itself start a 72 hour wait, so a reader who
 * hit the daily budget cap would also be locked out of the re-run they never
 * got.
 *
 * @param db The database handle.
 * @param params The headword and the direction.
 * @param at The moment the job was queued.
 */
export async function touchReenrichmentCooldown(db: DictionaryDb, params: ReenrichmentKey, at: Date): Promise<void> {
  await db
    .insert(reenrichmentLog)
    .values({
      headwordId: params.headwordId,
      fromLanguageCode: params.from,
      toLanguageCode: params.to,
      lastQueuedAt: at,
    })
    .onConflictDoUpdate({
      target: [reenrichmentLog.headwordId, reenrichmentLog.fromLanguageCode, reenrichmentLog.toLanguageCode],
      set: { lastQueuedAt: at },
    });
}

/**
 * Everything the vote action needs in order to decide whether a re-enrichment is
 * worth queueing. Deliberately no lemma and no output: the decision is taken
 * from identifiers and version numbers only.
 */
export interface EnrichmentIdentity {
  id: string;
  headwordId: string;
  senseId: string;
  fromLanguageCode: string;
  toLanguageCode: string;
  model: string;
  promptVersion: number;
}

/**
 * The identity of one enrichment, or `null` when the id names nothing.
 *
 * A `null` here is what turns an unknown id into a 400 rather than a crash, so
 * a hand-typed or stale id from a browser is an ordinary bad request.
 *
 * @param db The database handle.
 * @param enrichmentId The enrichment to read.
 * @returns its identifying columns, or `null`.
 */
export async function readEnrichmentRow(db: DictionaryDb, enrichmentId: string): Promise<EnrichmentIdentity | null> {
  const [row] = await db
    .select({
      id: enrichments.id,
      headwordId: enrichments.headwordId,
      senseId: enrichments.senseId,
      fromLanguageCode: enrichments.fromLanguageCode,
      toLanguageCode: enrichments.toLanguageCode,
      model: enrichments.model,
      promptVersion: enrichments.promptVersion,
    })
    .from(enrichments)
    .where(eq(enrichments.id, enrichmentId))
    .limit(1);

  return row ?? null;
}
