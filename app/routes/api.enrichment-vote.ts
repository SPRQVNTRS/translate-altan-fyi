import { z } from 'zod';

import type { Route } from './+types/api.enrichment-vote';
import { isServedLanguage } from '#app/lib/dictionary/detect-language';
import { isBudgetExhausted } from '#app/lib/abuse/budget.server';
import { enqueueEnrichment } from '#app/lib/enrichment/enqueue.server';
import { jsonError } from '#app/lib/api-auth.server';
import { createComponentLogger } from '#app/lib/logger';
import { requireVoterAccount } from '#app/lib/votes/account-gate.server';
import { isCooldownActive, isLowQuality, qualityScore, type VoteTally } from '#app/lib/votes/score';
import {
  castVote,
  flagForReview,
  readEnrichmentRow,
  readReenrichmentCooldown,
  tallyVotes,
  touchReenrichmentCooldown,
  type EnrichmentIdentity,
  type VoteValue,
} from '#app/models/votes.server';
import { getActiveModel } from '#app/models/app-settings.server';
import { PROMPT_VERSION } from '#app/prompts/enrichment/version';
import { getRawDb } from '#drizzle/tenant-db';

/**
 * `POST /api/enrichment-vote`, the one place a reader's judgement is recorded.
 *
 * AN ACTION ONLY, AND IT ALWAYS ANSWERS JSON.
 *   There is no loader: nothing here is readable, and a GET against this path
 *   should 405 rather than serve a shape somebody starts depending on. Every
 *   outcome is a JSON body with a `state` discriminant, never a redirect,
 *   because the caller is a fetcher inside an already-rendered entry page.
 *
 * THE PRIVACY RULE GOVERNS THIS FILE.
 *   A vote row records an enrichment id and an account id and NOTHING ELSE. This
 *   route is the only place that holds an account id and a dictionary object in
 *   the same scope, so it is the only place the product's claim can be lost. The
 *   headword, the lemma and the query text are never logged here, at any level,
 *   and the log lines below carry ids and outcomes only. A debug line pairing a
 *   reader with a word is a search log, whatever it is called.
 *
 * NO ENGLISH PROSE REACHES THE BROWSER FROM HERE.
 *   The refusal body carries a wordsmith key from `app/locales/*\/common.json`
 *   and the client resolves it. Writing the sentence here would put one
 *   untranslated string in the middle of a translated page, and no gate catches
 *   that.
 */

const log = createComponentLogger('EnrichmentVote');

/**
 * The form body, decoded at the boundary.
 *
 * `value` arrives as the STRING `'1'` or `'-1'`, because a form encodes
 * everything as text. The enum pins the two acceptable spellings and the
 * transform turns them into the numeric literals the model layer takes, so no
 * numeric parsing and no range check is needed further in.
 */
const voteSubmissionSchema = z.object({
  enrichmentId: z.uuid(),
  value: z.enum(['1', '-1']).transform((raw): VoteValue => (raw === '1' ? 1 : -1)),
});

/** Every way this route can answer, as one union the client switches on. */
export type VoteOutcome =
  | { state: 'unauthenticated'; messageKey: string }
  | { state: 'invalid' }
  | { state: 'recorded'; myVote: VoteValue; up: number; down: number }
  | { state: 'improving'; myVote: VoteValue; up: number; down: number }
  | { state: 'flagged'; myVote: VoteValue; up: number; down: number }
  | { state: 'budget'; myVote: VoteValue; up: number; down: number };

export async function action({ request }: Route.ActionArgs): Promise<Response> {
  if (request.method !== 'POST') throw jsonError(405, 'method not allowed');

  // The gate first, before the body is read. A signed-out visitor gets the same
  // answer whatever they posted, so there is nothing to learn by posting a
  // well-formed body versus a broken one.
  const accountId = await requireVoterAccount(request);
  if (accountId === null) {
    return Response.json({ state: 'unauthenticated', messageKey: 'enrichment.voteSignIn' }, { status: 401 });
  }

  const form = await request.formData();
  const parsed = voteSubmissionSchema.safeParse({
    enrichmentId: form.get('enrichmentId'),
    value: form.get('value'),
  });
  if (!parsed.success) return Response.json({ state: 'invalid' }, { status: 400 });

  const db = getRawDb();

  // The row is read BEFORE the vote is cast. `enrichment_votes.enrichmentId` is
  // a foreign key, so inserting against an unknown id would fail as a database
  // error deep in the action; reading first turns a stale id from an old open
  // tab into an ordinary 400.
  const enrichment = await readEnrichmentRow(db, parsed.data.enrichmentId);
  if (enrichment === null) return Response.json({ state: 'invalid' }, { status: 400 });

  await castVote(db, {
    enrichmentId: enrichment.id,
    accountId,
    value: parsed.data.value,
  });

  const tally = await tallyVotes(db, enrichment.id);
  const outcome = await decideAfterVote({ enrichment, tally });

  log.info('Enrichment vote recorded', { enrichmentId: enrichment.id, outcome });
  const body = {
    state: outcome,
    myVote: parsed.data.value,
    up: tally.up,
    down: tally.down,
  } satisfies VoteOutcome;
  return Response.json(body);
}

/** What the vote led to, beyond being counted. */
type PostVoteOutcome = 'recorded' | 'improving' | 'flagged' | 'budget';

interface DecideAfterVoteParams {
  enrichment: EnrichmentIdentity;
  tally: VoteTally;
}

/**
 * The re-enrichment decision, in the one order the steps are safe in.
 *
 * Each guard below refuses for a DIFFERENT reason, and the order matters:
 * cheaper and more certain refusals come first, so a request that is going to be
 * turned away costs as little as possible and never touches the cooldown row on
 * its way out.
 */
async function decideAfterVote({ enrichment, tally }: DecideAfterVoteParams): Promise<PostVoteOutcome> {
  // 1. Is there a verdict at all, and is it bad? `qualityScore` returns null
  //    below the minimum vote count, and `isLowQuality(null)` is false, so a
  //    fresh enrichment with one angry vote stops here and costs nothing.
  const score = qualityScore(tally);
  if (!isLowQuality(score)) return 'recorded';

  const db = getRawDb();

  // 2. Would a re-run produce anything new? If the row already carries the
  //    CURRENT model and the CURRENT prompt version, the answer is no: identical
  //    input through an identical model under an identical prompt reproduces the
  //    reader's complaint at full price. Flag it for a human and queue nothing.
  const active = await getActiveModel();
  if (enrichment.model === active.model && enrichment.promptVersion === PROMPT_VERSION) {
    await flagForReview(db, enrichment.id);
    return 'flagged';
  }

  // The direction columns are plain text on the enrichments table, so they are
  // decoded before they can be put on a queue payload. A row written for a
  // language this build no longer serves is stale in a way a re-run cannot fix,
  // so it counts as recorded rather than as an error the reader must see.
  const from = enrichment.fromLanguageCode;
  const to = enrichment.toLanguageCode;
  if (!isServedLanguage(from) || !isServedLanguage(to)) return 'recorded';

  // 3. Has this pair already been re-run recently? The cooldown is the spend
  //    guard against a small group clicking in turn: without it, five readers
  //    can order five paid runs of one headword in five minutes.
  const key = { headwordId: enrichment.headwordId, from, to };
  const lastQueuedAt = await readReenrichmentCooldown(db, key);
  if (isCooldownActive(lastQueuedAt, new Date())) return 'recorded';

  // 4. Is there money left today? Checked BEFORE queueing rather than inside the
  //    worker, so the reader is told now instead of watching a job be created
  //    and then refused out of sight. The cooldown is deliberately NOT touched
  //    on this path: a refusal must not start a 72 hour wait for a run that
  //    never happened.
  if (await isBudgetExhausted()) return 'budget';

  // 5. Queue it. `enqueueEnrichment` carries the singleton key, so two readers
  //    voting seconds apart collide into one job rather than two, and the
  //    payload carries no account id by construction.
  const enqueued = await enqueueEnrichment({
    headwordId: enrichment.headwordId,
    from,
    to,
    promptVersion: PROMPT_VERSION,
  });

  // 6. What the enqueue actually did decides whether the cursor moves.
  //
  //    `unavailable` means the workflow orchestrator is not up, so NOTHING was
  //    queued. Touching the cooldown here would start a 72 hour wait for a run
  //    that never happened, and every later down-vote on this headword would be
  //    refused for three days because of an outage no reader can see. The vote
  //    itself did land, so `recorded` is the honest answer: it counts the vote
  //    and promises no improvement, and the next vote may try again as soon as
  //    the queue is back.
  if (enqueued === 'unavailable') return 'recorded';

  // `queued` and `deduped` are BOTH successes: work is on the queue either way.
  // `deduped` in particular must move the cursor, because the singleton key
  // collapsed this request into a run that is already going ahead. Skipping the
  // touch on a dedupe would leave a busy headword with no cursor at all, and a
  // busy headword is exactly the one the cooldown exists to protect.
  await touchReenrichmentCooldown(db, key, new Date());
  return 'improving';
}
