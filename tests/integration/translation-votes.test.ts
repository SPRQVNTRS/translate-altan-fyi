/**
 * A vote on one translated word, driven through the real route.
 *
 * WHAT THIS FILE HOLDS IN PLACE
 *   `POST /api/translation-vote` is where a reader says one of the words in an
 *   answer is wrong. Nothing automatic hangs off that vote this milestone, so
 *   the value of the row is entirely in its being CORRECT, and three things can
 *   make it wrong in ways nothing else notices.
 *
 *   1. ONE VOTE PER READER PER EDGE. The composite primary key on
 *      (translationId, accountId) is the whole rule, and `castTranslationVote`
 *      upserts on it. A plain insert would append a second row, the tally would
 *      count one person twice, and a single reader could push a score as far as
 *      they liked by clicking again.
 *   2. THE VOTE HAS TO COME BACK ON THE NEXT READ. `listTranslationsInto`
 *      carries the edge id and the tally on the same statement, and marks the
 *      reader's own vote when an account is passed. If it did not, a reload
 *      would show the buttons unpressed and the reader would vote again.
 *   3. AN ANONYMOUS VOTE IS REFUSED, LOUDLY. A 401 with no row written, rather
 *      than a quiet 200 that drops the vote: a reader who is silently ignored
 *      clicks again, and a vote path that accepts anonymous writes has no
 *      "one vote per reader" rule left at all.
 *
 * NO PROVIDER AND NO QUEUE ARE INVOLVED. A vote is recorded and nothing else
 * (M194 decision 8), so there is no job to watch and no money to spend. Every
 * assertion is a row.
 *
 * THE PRECONDITION IS A REACHABLE DATABASE
 *   `DB_HOST` and the other `DB_*` variables, nothing else. Every case gates on
 *   `DB_HOST` alone, which `tests/unit/integration-tests-self-skip.test.ts`
 *   enforces.
 *
 * ISOLATION
 *   Every dictionary row this file votes on is created by this file: its own
 *   source, two headwords, three senses and two edges, all under fresh random
 *   UUIDs, and all deleted in `after()` in foreign-key-safe order. No existing
 *   dictionary row is read, written or reused.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';

import { getRawDb, pool, poolInitialized } from '../../drizzle/db';
import { headwords, senses, sources, translationVotes, translations, users } from '../../drizzle/schema';
import { action } from '../../app/routes/api.translation-vote';
import { listTranslationsInto } from '../../app/lib/translation/translations-query.server';
import { listDownVotedTranslations } from '../../app/models/translation-votes.server';
import { sessionStorage } from '../../app/services/session.server';

const DB_HOST = process.env.DB_HOST;

const db = getRawDb();

/** Every row this file creates, under ids that exist nowhere else. */
const SOURCE_ID = randomUUID();
const FROM_HEADWORD_ID = randomUUID();
const FROM_SENSE_ID = randomUUID();
const FIRST_TARGET_HEADWORD_ID = randomUUID();
const FIRST_TARGET_SENSE_ID = randomUUID();
const SECOND_TARGET_HEADWORD_ID = randomUUID();
const SECOND_TARGET_SENSE_ID = randomUUID();
const VOTED_EDGE_ID = randomUUID();
const QUIET_EDGE_ID = randomUUID();

/** The direction the fixture is written for. Both codes are served. */
const FROM = 'de';
const TO = 'en';

/** The word the voted edge points at, so the operator's list can be matched on it. */
const VOTED_LEMMA = `zz-voted-${randomUUID().slice(0, 8)}`;

/**
 * The two signed-in readers whose votes drive the route.
 *
 * REAL ROWS, NOT ARBITRARY IDS. `translation_votes.accountId` carries a foreign
 * key to `users`, so a vote by a user that does not exist is refused by
 * Postgres. Their ids are whatever `serial` hands out.
 */
let voterAccountId = 0;
let secondVoterAccountId = 0;

/**
 * The response body, decoded rather than trusted.
 *
 * The route answers three shapes behind one `state` discriminant, and a test
 * that read `body.state` off an untyped value would keep passing if the field
 * were renamed.
 */
const voteResponseSchema = z.object({
  state: z.string(),
  up: z.number().optional(),
  down: z.number().optional(),
  myVote: z.number().optional(),
  messageKey: z.string().optional(),
});

/** A `Cookie` header holding a real signed session for one user id. */
async function signedCookieFor(accountId: number): Promise<string> {
  const session = await sessionStorage.getSession();
  session.set('user', { id: accountId, issuedAt: new Date().toISOString() });
  const setCookie = await sessionStorage.commitSession(session);
  return setCookie.split(';')[0] ?? '';
}

/** One throwaway user, so a vote has something to point its foreign key at. */
async function seedAccount(): Promise<number> {
  const [row] = await db
    .insert(users)
    .values({
      email: `zz-translation-voter-${randomUUID()}@example.invalid`,
      // A fixed non-secret string of the right shape. This file never
      // authenticates; it only needs a row the foreign key can resolve.
      passwordHash: '$2b$10$abcdefghijklmnopqrstuvwxyz012345678901234567890123456789',
      emailVerifiedAt: new Date(),
    })
    .returning({ id: users.id });
  if (!row) throw new Error('failed to seed the fixture user');
  return row.id;
}

/** Post one vote to the route, exactly as a translation row's buttons do. */
async function postVote(params: { translationId: string; value: string; cookie: string | null }): Promise<Response> {
  const body = new FormData();
  body.set('translationId', params.translationId);
  body.set('value', params.value);

  const headers = new Headers();
  if (params.cookie !== null) headers.set('cookie', params.cookie);

  const request = new Request('https://translate.altan.fyi/api/translation-vote', {
    method: 'POST',
    headers,
    body,
  });

  return action({ request });
}

/** The decoded JSON body of a route response. */
async function readBody(response: Response): Promise<z.infer<typeof voteResponseSchema>> {
  return voteResponseSchema.parse(await response.json());
}

/** How many votes exist for one edge. */
async function countVotes(translationId: string): Promise<number> {
  const rows = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(translationVotes)
    .where(eq(translationVotes.translationId, translationId));
  return rows[0]?.count ?? 0;
}

before(async () => {
  if (!DB_HOST) return;
  await poolInitialized;

  await db.insert(sources).values({
    id: SOURCE_ID,
    slug: `translation-votes-test-${SOURCE_ID}`,
    name: 'Translation vote test fixture',
    // Served, so the corpus query can see these rows. An unserved licence would
    // make the read cases pass on an empty list, which is no assertion at all.
    licence: 'CC0-1.0',
    attribution: 'test fixture, deleted by this file',
  });

  await db.insert(headwords).values([
    {
      id: FROM_HEADWORD_ID,
      languageCode: FROM,
      lemma: `zz-from-${FROM_HEADWORD_ID}`,
      lemmaNormalized: `zz-from-${FROM_HEADWORD_ID}`,
      sourceId: SOURCE_ID,
    },
    {
      id: FIRST_TARGET_HEADWORD_ID,
      languageCode: TO,
      lemma: VOTED_LEMMA,
      lemmaNormalized: VOTED_LEMMA,
      pos: 'verb',
      sourceId: SOURCE_ID,
    },
    {
      id: SECOND_TARGET_HEADWORD_ID,
      languageCode: TO,
      lemma: `zz-quiet-${SECOND_TARGET_HEADWORD_ID}`,
      lemmaNormalized: `zz-quiet-${SECOND_TARGET_HEADWORD_ID}`,
      pos: 'verb',
      sourceId: SOURCE_ID,
    },
  ]);

  await db.insert(senses).values([
    { id: FROM_SENSE_ID, headwordId: FROM_HEADWORD_ID, sourceId: SOURCE_ID },
    { id: FIRST_TARGET_SENSE_ID, headwordId: FIRST_TARGET_HEADWORD_ID, sourceId: SOURCE_ID },
    { id: SECOND_TARGET_SENSE_ID, headwordId: SECOND_TARGET_HEADWORD_ID, sourceId: SOURCE_ID },
  ]);

  await db.insert(translations).values([
    { id: VOTED_EDGE_ID, fromSenseId: FROM_SENSE_ID, toSenseId: FIRST_TARGET_SENSE_ID, sourceId: SOURCE_ID },
    // A second edge nobody votes on, so "this reader's own vote" can be shown to
    // be per row rather than per answer.
    { id: QUIET_EDGE_ID, fromSenseId: FROM_SENSE_ID, toSenseId: SECOND_TARGET_SENSE_ID, sourceId: SOURCE_ID },
  ]);

  voterAccountId = await seedAccount();
  secondVoterAccountId = await seedAccount();
});

after(async () => {
  if (!DB_HOST) {
    await pool.end();
    return;
  }

  // Foreign-key-safe order, innermost first. Every predicate names a row this
  // file created and nothing else.
  await db.delete(translationVotes).where(inArray(translationVotes.translationId, [VOTED_EDGE_ID, QUIET_EDGE_ID]));
  await db.delete(translations).where(inArray(translations.id, [VOTED_EDGE_ID, QUIET_EDGE_ID]));
  await db.delete(senses).where(inArray(senses.id, [FROM_SENSE_ID, FIRST_TARGET_SENSE_ID, SECOND_TARGET_SENSE_ID]));
  await db
    .delete(headwords)
    .where(inArray(headwords.id, [FROM_HEADWORD_ID, FIRST_TARGET_HEADWORD_ID, SECOND_TARGET_HEADWORD_ID]));
  await db.delete(sources).where(eq(sources.id, SOURCE_ID));
  // Last, and after the votes: the vote foreign key cascades, but deleting the
  // accounts first would silently take rows this file wanted to assert on.
  for (const accountId of [voterAccountId, secondVoterAccountId]) {
    if (accountId !== 0) await db.delete(users).where(eq(users.id, accountId));
  }

  await pool.end();
});

describe('translation votes: casting one', () => {
  it(
    'replaces the earlier vote of one reader instead of adding a second row',
    { skip: !DB_HOST ? 'DB_HOST not set' : false },
    async () => {
      const cookie = await signedCookieFor(voterAccountId);

      const first = await readBody(await postVote({ translationId: VOTED_EDGE_ID, value: '1', cookie }));
      assert.equal(first.state, 'recorded');
      assert.equal(first.up, 1);
      assert.equal(first.down, 0);

      const [firstRow] = await db
        .select({ value: translationVotes.value, updatedAt: translationVotes.updatedAt })
        .from(translationVotes)
        .where(eq(translationVotes.translationId, VOTED_EDGE_ID));
      assert.ok(firstRow !== undefined, 'the first vote wrote no row');
      assert.equal(firstRow.value, 1);

      // A gap the clock can resolve, so "the timestamp moved" is a real
      // observation rather than a coin toss on millisecond boundaries.
      await new Promise((resolve) => setTimeout(resolve, 5));

      const second = await readBody(await postVote({ translationId: VOTED_EDGE_ID, value: '-1', cookie }));

      assert.equal(
        await countVotes(VOTED_EDGE_ID),
        1,
        'the second vote added a row instead of replacing the first, so one reader is counted twice and can ' +
          'push a score as far as they like by clicking again',
      );
      assert.equal(second.up, 0, 'the tally did not follow the changed vote');
      assert.equal(second.down, 1);
      assert.equal(second.myVote, -1);

      const [secondRow] = await db
        .select({
          value: translationVotes.value,
          updatedAt: translationVotes.updatedAt,
          accountId: translationVotes.accountId,
        })
        .from(translationVotes)
        .where(eq(translationVotes.translationId, VOTED_EDGE_ID));
      assert.ok(secondRow !== undefined);
      assert.equal(secondRow.value, -1, 'the second vote did not win, so a reader cannot change their mind');
      assert.ok(
        secondRow.updatedAt.getTime() > firstRow.updatedAt.getTime(),
        "updatedAt is frozen at the first vote. Drizzle's $onUpdate hook does not fire inside a conflict " +
          'clause, so the column has to be set explicitly there, and a stale timestamp misreports when a tally ' +
          'last changed.',
      );
      // The account id is the signed-in reader's own, and it is the ONLY thing
      // on the row besides the edge: no headword, no lemma, no query.
      assert.equal(secondRow.accountId, voterAccountId);
    },
  );

  it(
    'counts a second reader as a second vote on the same edge',
    { skip: !DB_HOST ? 'DB_HOST not set' : false },
    async () => {
      const cookie = await signedCookieFor(secondVoterAccountId);
      const body = await readBody(await postVote({ translationId: VOTED_EDGE_ID, value: '-1', cookie }));

      assert.equal(body.down, 2, 'the vote of the second reader was not counted');
      assert.equal(await countVotes(VOTED_EDGE_ID), 2);
    },
  );

  it(
    'refuses an anonymous vote with 401 and writes nothing',
    { skip: !DB_HOST ? 'DB_HOST not set' : false },
    async () => {
      const votesBefore = await countVotes(QUIET_EDGE_ID);

      const response = await postVote({ translationId: QUIET_EDGE_ID, value: '-1', cookie: null });
      const body = await readBody(response);

      assert.equal(
        response.status,
        401,
        `an anonymous vote answered ${response.status}. A silent 200 would drop the vote while telling the ` +
          'reader it counted, and the reader then clicks again.',
      );
      assert.equal(body.state, 'unauthenticated');
      assert.equal(
        await countVotes(QUIET_EDGE_ID),
        votesBefore,
        'an anonymous vote wrote a row, so votes exist that belong to nobody and the one-vote-per-reader key ' +
          'means nothing',
      );
    },
  );

  it(
    'answers 400 for an id that names no edge, and writes nothing',
    { skip: !DB_HOST ? 'DB_HOST not set' : false },
    async () => {
      const cookie = await signedCookieFor(voterAccountId);
      const strangerId = randomUUID();

      const response = await postVote({ translationId: strangerId, value: '1', cookie });

      assert.equal(
        response.status,
        400,
        'a stale id from an old open tab reached the insert. The foreign key would refuse it as a database ' +
          'error deep in the action, which is a 500 for what is really a bad request.',
      );
      assert.equal((await readBody(response)).state, 'invalid');
      assert.equal(await countVotes(strangerId), 0);
    },
  );
});

describe('translation votes: what the next read shows', () => {
  it(
    "carries the edge id, the tally and this reader's own vote back on the corpus read",
    { skip: !DB_HOST ? 'DB_HOST not set' : false },
    async () => {
      const rows = await listTranslationsInto(db, {
        headwordId: FROM_HEADWORD_ID,
        to: TO,
        accountId: voterAccountId,
      });

      const voted = rows.find((row) => row.translationId === VOTED_EDGE_ID);
      assert.ok(
        voted !== undefined,
        'the voted edge is not in the answer, so the id the buttons post is not the id the reader is looking at',
      );
      assert.equal(voted.lemma, VOTED_LEMMA);
      assert.equal(voted.up, 0);
      assert.equal(voted.down, 2, 'the tally did not ride along on the corpus read');
      assert.equal(
        voted.myVote,
        -1,
        "the reader's own vote is missing after a reload, so the buttons come back unpressed and the reader " +
          'votes again',
      );

      const quiet = rows.find((row) => row.translationId === QUIET_EDGE_ID);
      assert.ok(quiet !== undefined);
      assert.equal(quiet.down, 0);
      assert.equal(quiet.myVote, null, 'a vote on one edge marked another edge as voted, so the vote is per answer');
    },
  );

  it('marks nothing as mine when no account is passed', { skip: !DB_HOST ? 'DB_HOST not set' : false }, async () => {
    const rows = await listTranslationsInto(db, { headwordId: FROM_HEADWORD_ID, to: TO });
    const voted = rows.find((row) => row.translationId === VOTED_EDGE_ID);

    assert.ok(voted !== undefined);
    assert.equal(voted.down, 2, 'the shared tally is a property of the answer and must be read for everyone');
    assert.equal(voted.myVote, null, "an anonymous read claimed a vote, so somebody else's button is pressed");
  });

  it(
    "shows the down-voted word on the operator's list, with its pair",
    { skip: !DB_HOST ? 'DB_HOST not set' : false },
    async () => {
      const listed = await listDownVotedTranslations(db, 100);
      const row = listed.find((candidate) => candidate.translationId === VOTED_EDGE_ID);

      assert.ok(
        row !== undefined,
        "a down-voted edge is missing from the operator's list, which is the only place this milestone makes " +
          'the signal readable at all',
      );
      assert.equal(row.lemma, VOTED_LEMMA);
      assert.equal(row.fromLanguageCode, FROM);
      assert.equal(row.toLanguageCode, TO);
      assert.equal(row.down, 2);
      assert.equal(row.up, 0);
    },
  );
});
