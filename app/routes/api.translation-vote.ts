import { z } from 'zod';

import { jsonError } from '#app/lib/api-auth.server';
import { createComponentLogger } from '#app/lib/logger';
import { requireVoterAccount } from '#app/lib/votes/account-gate.server';
import { castTranslationVote, readTranslationEdge, tallyTranslationVotes } from '#app/models/translation-votes.server';
import type { VoteValue } from '#app/models/votes.server';
import { getRawDb } from '#drizzle/db';

/**
 * `POST /api/translation-vote`, where a reader's judgement of one translated
 * word is recorded.
 *
 * AN ACTION ONLY, AND IT ALWAYS ANSWERS JSON.
 *   There is no loader: nothing here is readable, and a GET against this path
 *   should 405 rather than serve a shape somebody starts depending on. Every
 *   outcome is a JSON body with a `state` discriminant, never a redirect,
 *   because the caller is a fetcher inside an already-rendered answer.
 *
 * IT IS SHORTER THAN `api.enrichment-vote.ts` BY DESIGN, NOT BY OMISSION.
 *   That route decides whether a down-vote buys a paid re-run, so it carries a
 *   quality score, a cooldown row, a budget check and a review flag. This one
 *   carries none of them, because a vote on a translation is RECORDED AND
 *   NOTHING ELSE (M194 decision 8): no re-run, no hiding, no re-ordering of the
 *   answer. The rows are the signal, and what to do with them is a decision to
 *   take on real data rather than to guess at now. The operator's list at
 *   `/super/llm` is the whole of what is built on top of them. A future
 *   milestone that adds a consequence here adds the guards with it; adding the
 *   consequence without them is how a click starts costing money.
 *
 * THE PRIVACY RULE GOVERNS THIS FILE.
 *   A vote row records a translation id and an account id and NOTHING ELSE.
 *   This route is one of the two places that hold an account id and a dictionary
 *   object in the same scope, so it is one of the two places the product's claim
 *   can be lost. The headword, the lemma and the query text are never logged
 *   here, at any level, and the line below carries an edge id and an outcome
 *   only. A debug line pairing a reader with a word is a search log, whatever it
 *   is called.
 *
 * NO ENGLISH PROSE REACHES THE BROWSER FROM HERE. The refusal body carries a
 * locale key and the client resolves it. Writing the sentence here would put one
 * untranslated string in the middle of a translated page, and no gate catches
 * that.
 *
 * THE ENTRY PAGE'S OWN TRANSLATION LIST IS NOT WIRED FOR THIS, and that is the
 * question a reader of this file will ask next. `entryTranslationsQuery` selects
 * no edge id and its rows are rendered through `sense-tabs.tsx`, so giving that
 * surface the same buttons means changing a second query and a second component.
 * It is a separate piece of work rather than a paragraph, and it was left out
 * on purpose.
 */

const log = createComponentLogger('TranslationVote');

/**
 * The form body, decoded at the boundary.
 *
 * `value` arrives as the STRING `'1'` or `'-1'`, because a form encodes
 * everything as text. The enum pins the two acceptable spellings and the
 * transform turns them into the numeric literals the model layer takes, so no
 * numeric parsing and no range check is needed further in.
 */
const translationVoteSubmissionSchema = z.object({
  translationId: z.uuid(),
  value: z.enum(['1', '-1']).transform((raw): VoteValue => (raw === '1' ? 1 : -1)),
});

/** Every way this route can answer, as one union the client switches on. */
export type TranslationVoteOutcome =
  | { state: 'unauthenticated'; messageKey: string }
  | { state: 'invalid' }
  | { state: 'recorded'; myVote: VoteValue; up: number; down: number };

/**
 * The one field this action reads.
 *
 * SPELLED OUT RATHER THAN TAKEN FROM `Route.ActionArgs`. Nothing here looks at a
 * dynamic param, at the matched pattern or at the middleware context, and a
 * structural parameter is what lets a test call this function with a bare
 * request instead of assembling five fields a vote never reads.
 */
export interface TranslationVoteActionArgs {
  request: Request;
}

export async function action({ request }: TranslationVoteActionArgs): Promise<Response> {
  if (request.method !== 'POST') throw jsonError(405, 'method not allowed');

  // The gate first, before the body is read. A signed-out visitor gets the same
  // answer whatever they posted, so there is nothing to learn by posting a
  // well-formed body versus a broken one.
  const accountId = await requireVoterAccount(request);
  if (accountId === null) {
    return Response.json({ state: 'unauthenticated', messageKey: 'translationVote.signIn' }, { status: 401 });
  }

  const form = await request.formData();
  const parsed = translationVoteSubmissionSchema.safeParse({
    translationId: form.get('translationId'),
    value: form.get('value'),
  });
  if (!parsed.success) return Response.json({ state: 'invalid' }, { status: 400 });

  const db = getRawDb();

  // The edge is read BEFORE the vote is cast. `translation_votes.translationId`
  // is a foreign key, so inserting against an unknown id would fail as a
  // database error deep in the action; reading first turns a stale id from an
  // old open tab into an ordinary 400.
  const translationId = await readTranslationEdge(db, parsed.data.translationId);
  if (translationId === null) return Response.json({ state: 'invalid' }, { status: 400 });

  await castTranslationVote(db, { translationId, accountId, value: parsed.data.value });

  // The tally is read back rather than computed from the previous figures. The
  // client already guesses optimistically; this is the number that corrects the
  // guess, and it has to include the votes of everybody else who clicked while
  // this reader was reading.
  const tally = await tallyTranslationVotes(db, translationId);

  log.info('Translation vote recorded', { translationId });
  const body = {
    state: 'recorded',
    myVote: parsed.data.value,
    up: tally.up,
    down: tally.down,
  } satisfies TranslationVoteOutcome;
  return Response.json(body);
}
